/**
 * The plugin's single persistent `/ws/tts/multi` connection: background
 * send/recv loops, per-context routing, and the diagnostics operations of
 * the connection and of each context turn (contract "Operation scope" in
 * `services/ingress/docs/sdk-diagnostics-contract.md`).
 */

import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  createTimedString,
  log,
} from '@livekit/agents';
import { type RawData, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';

import type { Diagnostics, Operation } from '../diagnostics';
import { classifyWsFrame, classifyWsHandshakeError } from '../errors';
import type { AudioSink } from './audioSink';
import {
  buildClosePayload,
  buildMultiWsUrl,
  buildTextPayload,
  wordTimestampsToTimed,
  type WireOptions,
} from './wire';

export interface ResolvedTTSOptions extends WireOptions {
  apiKey: string;
  baseURL: string;
}

/** Convert an ingress WS error frame into LiveKit's status exception. */
function apiStatusErrorFromFrame(
  data: { error?: string; error_code?: string; code?: number },
  requestId: string,
): APIStatusError {
  const err = classifyWsFrame(data);
  const statusCode = err.statusCode ?? (typeof data.code === 'number' ? data.code : 500);
  return new APIStatusError({
    message: err.message,
    options: { statusCode, requestId, body: data },
  });
}

/**
 * Convert a KugelAudio connection/handshake error into a LiveKit exception.
 * A refused upgrade's `x-request-id` (on `err.headers`) becomes `requestId`.
 */
export function toLiveKitConnError(err: unknown): APIConnectionError {
  if (err instanceof Error && /handshake has timed out/i.test(err.message)) {
    return new APITimeoutError({ message: 'Timed out connecting to /ws/tts/multi' });
  }
  const typed = classifyWsHandshakeError(err);
  if (typed && typed.statusCode !== undefined) {
    return new APIStatusError({
      message: typed.message,
      options: { statusCode: typed.statusCode, requestId: typed.requestId ?? null },
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new APIConnectionError({ message: `Failed to connect to /ws/tts/multi: ${message}` });
}

/** A resolvable/rejectable promise handle. */
export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  settled: boolean;
}

export function deferred(): Deferred {
  const d = { settled: false } as Deferred;
  d.promise = new Promise<void>((resolve, reject) => {
    d.resolve = () => {
      if (d.settled) return;
      d.settled = true;
      resolve();
    };
    d.reject = (err: Error) => {
      if (d.settled) return;
      d.settled = true;
      reject(err);
    };
  });
  // Swallow unhandled-rejection noise; consumers await via waitForContextIdle.
  d.promise.catch(() => {});
  return d;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ContextData {
  sink: AudioSink;
  waiter: Deferred;
  isStreaming: boolean;
  lastActivityAt: number;
  /**
   * Diagnostics operation of the synthesis this context serves. Owned and
   * settled by the stream (which knows about LiveKit's retries); the
   * connection only annotates it.
   */
  op: Operation | null;
}

/**
 * Single persistent WebSocket to `/ws/tts/multi` with background send/recv
 * loops. Each synthesis registers a unique `context_id`; the recv loop routes
 * server messages by id and silently drops messages for unknown/closed
 * contexts, which is what makes barge-in safe.
 */
export class Connection {
  #opts: ResolvedTTSOptions;
  #diagnostics: Diagnostics | null;
  #ws: WebSocket | null = null;
  #isCurrent = true;
  #closed = false;
  #activeContexts = new Set<string>();
  #contexts = new Map<string, ContextData>();
  #inputQueue: Record<string, unknown>[] = [];
  #inputResolver: (() => void) | null = null;
  #sendTask: Promise<void> | null = null;
  #recvTask: Promise<void> | null = null;
  #logger = log();

  constructor(opts: ResolvedTTSOptions, diagnostics: Diagnostics | null = null) {
    this.#opts = opts;
    this.#diagnostics = diagnostics;
  }

  get isCurrent(): boolean {
    return this.#isCurrent;
  }

  get closed(): boolean {
    return this.#closed;
  }

  markNonCurrent(): void {
    this.#isCurrent = false;
  }

  async connect(timeoutMs = 10_000, signal?: AbortSignal): Promise<void> {
    // Establishing the connection is its own operation: it succeeds at OPEN,
    // and every failing exit below funnels through the single `catch`. The
    // turns carried on the connection are operations of their own.
    const op =
      this.#diagnostics?.startOperation('multi_context', 'websocket') ?? null;
    try {
      signal?.throwIfAborted();
      const url = buildMultiWsUrl(this.#opts.baseURL, this.#opts.apiKey);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const started = performance.now();
        const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
        this.#ws = ws;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          ws.off('open', onOpen);
          ws.off('unexpected-response', onResponse);
          ws.off('close', onClose);
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          this.#closed = true;
          this.#isCurrent = false;
          // Also aborts CONNECTING requests. Retain the error listener until
          // close so the asynchronous abort error always has an observer.
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
          this.#ws = null;
          reject(error);
        };
        const timeout = () => fail(new APITimeoutError({
          message: `Timed out connecting to /ws/tts/multi (handshake budget ${Math.ceil(timeoutMs)}ms)`,
        }));
        const timer = setTimeout(timeout, timeoutMs);
        timer.unref?.();
        const onAbort = () => fail(signal!.reason);
        const onOpen = () => {
          if (performance.now() - started >= timeoutMs) { timeout(); return; }
          settled = true;
          cleanup();
          op?.succeed();
          this.#sendTask = this.#sendLoop();
          this.#recvTask = this.#recvLoop();
          resolve();
        };
        const onResponse = (_req: unknown, res: IncomingMessage) => {
          op?.markStage('handshake');
          // The rejection response carries ingress's x-request-id.
          fail(toLiveKitConnError({
            statusCode: res.statusCode,
            message: res.statusMessage,
            headers: res.headers,
          }));
          res.destroy();
        };
        const onClose = () => fail(new APIConnectionError({ message: 'Connection closed before ready' }));
        const onError = (err: Error) => fail(toLiveKitConnError(err));
        ws.on('open', onOpen);
        ws.on('unexpected-response', onResponse);
        ws.on('close', onClose);
        ws.on('error', onError);
        ws.once('close', () => ws.off('error', onError));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } catch (err) {
      // `signal` aborts only for TTS.close() or the caller's own abort (the
      // handshake budget has its own timer), so an aborted signal is a
      // caller cancellation whatever reason it carries, e.g. the
      // APIConnectionError TTS.close() aborts with.
      if (signal?.aborted) op?.cancel();
      else op?.fail(err);
      throw err;
    }
  }

  registerContext(
    contextId: string,
    sink: AudioSink,
    waiter: Deferred,
    isStreaming: boolean,
    op: Operation | null = null,
  ): ContextData | null {
    if (this.#closed) {
      waiter.reject(
        new APIConnectionError({ message: 'Connection closed before request started' }),
      );
      return null;
    }
    const ctx: ContextData = {
      sink,
      waiter,
      isStreaming,
      lastActivityAt: Date.now(),
      op,
    };
    op?.markStage('sending_request');
    this.#contexts.set(contextId, ctx);
    return ctx;
  }

  sendText(contextId: string, text: string, flush: boolean): void {
    const op = this.#contexts.get(contextId)?.op;
    // The turn's first text is on its way: from here on we wait for audio.
    if (text && op?.failureStage === 'sending_request') op.markStage('awaiting_first_audio');
    const includeConfig = !this.#activeContexts.has(contextId);
    if (includeConfig) this.#activeContexts.add(contextId);
    this.#enqueue(buildTextPayload(contextId, text, this.#opts, { flush, includeConfig }));
  }

  closeContext(contextId: string, immediate: boolean): void {
    this.#enqueue(buildClosePayload(contextId, immediate));
  }

  cleanupContext(contextId: string): void {
    this.#contexts.delete(contextId);
    this.#activeContexts.delete(contextId);
  }

  #enqueue(payload: Record<string, unknown>): void {
    if (this.#closed) return;
    this.#inputQueue.push(payload);
    this.#inputResolver?.();
  }

  async #sendLoop(): Promise<void> {
    try {
      while (!this.#closed) {
        if (this.#inputQueue.length === 0) {
          await new Promise<void>((resolve) => {
            this.#inputResolver = resolve;
          });
          this.#inputResolver = null;
        }
        if (this.#closed) break;
        const payload = this.#inputQueue.shift();
        if (!payload) continue;
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) break;
        this.#ws.send(JSON.stringify(payload));
      }
    } catch (err) {
      this.#logger.warn({ error: err }, 'kugelaudio livekit send loop error');
      this.#isCurrent = false;
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) this.#ws.close();
    }
  }

  async #recvLoop(): Promise<void> {
    const ws = this.#ws;
    if (!ws) return;
    let closeCode: number | undefined;
    try {
      await new Promise<void>((resolve) => {
        const onMessage = (raw: RawData) => {
          const text =
            typeof raw === 'string'
              ? raw
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString()
                : raw instanceof ArrayBuffer
                  ? Buffer.from(raw).toString()
                  : (raw as Buffer).toString();
          try {
            this.#handleMessage(JSON.parse(text));
          } catch (err) {
            this.#logger.warn({ error: err }, 'failed to parse /ws/tts/multi message');
          }
        };
        const finish = () => {
          ws.off('message', onMessage);
          ws.off('close', onClose);
          ws.off('error', finish);
          resolve();
        };
        const onClose = (code: number) => {
          closeCode = code;
          finish();
        };
        ws.on('message', onMessage);
        ws.on('close', onClose);
        ws.on('error', finish);
      });
    } finally {
      // Connection dropped — reject any still-pending waiters so their streams
      // don't hang, and mark dead so the next call reconnects.
      // A caller's close() has already cancelled and cleared its contexts,
      // so every context still here was interrupted by the drop.
      this.#isCurrent = false;
      for (const ctx of this.#contexts.values()) {
        const err = new APIConnectionError({ message: 'WebSocket connection closed unexpectedly' });
        ctx.op?.markWsCloseCode(closeCode);
        ctx.waiter.reject(err);
      }
    }
  }

  #handleMessage(data: Record<string, unknown>): void {
    if (data.session_closed) {
      // Terminal frame: the server is tearing the session down and will close
      // the socket next. Mark non-current now so no new synthesis grabs this
      // dying connection; the close event rejects any pending waiters.
      this.#isCurrent = false;
      return;
    }
    const contextId = typeof data.context_id === 'string' ? data.context_id : undefined;

    if (data.error) {
      // The server's answer fails the turn: request_failed, with the frame's
      // error_code and request_id rather than LiveKit's wrapper.
      const frameErr = classifyWsFrame(data);
      const failTurn = (ctx: ContextData | undefined) => ctx?.op?.markServerError(frameErr);
      if (contextId) {
        const ctx = this.#contexts.get(contextId);
        failTurn(ctx);
        ctx?.waiter.reject(apiStatusErrorFromFrame(data, contextId));
        this.cleanupContext(contextId);
      } else {
        // Session errors (including MODEL_UNAVAILABLE) have no context id.
        // Preserve the server's error for every pending caller before closing;
        // retries must use a fresh session, and late audio must be discarded.
        this.#isCurrent = false;
        for (const [id, ctx] of this.#contexts) {
          failTurn(ctx);
          ctx.waiter.reject(apiStatusErrorFromFrame(data, id));
          this.cleanupContext(id);
        }
        void this.close();
      }
      return;
    }

    const ctx = contextId ? this.#contexts.get(contextId) : undefined;
    // Messages for unknown/cleaned-up contexts are silently discarded — the
    // core barge-in safety property.
    if (!ctx) return;

    ctx.lastActivityAt = Date.now();

    if (data.context_timeout) {
      const err = new APITimeoutError({ message: 'context timed out' });
      ctx.op?.markServerError(err);
      ctx.waiter.reject(err);
      this.cleanupContext(contextId!);
      return;
    }

    if (typeof data.audio === 'string') {
      const pcm = Buffer.from(data.audio, 'base64');
      ctx.op?.recordChunk(pcm.byteLength);
      ctx.sink.pushAudio(pcm);
    }

    if (Array.isArray(data.word_timestamps)) {
      ctx.sink.pushTimed(
        wordTimestampsToTimed(data.word_timestamps as never).map((w) => createTimedString(w)),
      );
    }

    if (data.chunk_complete) {
      // Sentence boundary: deliver the buffered audio tail now instead of
      // holding it until the next sentence's bytes arrive.
      ctx.sink.flush();
      if (!ctx.isStreaming) {
        // Non-streaming context: close after the server confirms generation
        // is done, avoiding the race where close arrives before audio is
        // generated.
        this.closeContext(contextId!, false);
      }
    }

    if (data.context_closed) {
      ctx.sink.end();
      ctx.waiter.resolve();
      this.cleanupContext(contextId!);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#inputQueue.length = 0;
    this.#activeContexts.clear();
    this.#inputResolver?.();
    for (const ctx of this.#contexts.values()) {
      // The caller (TTS.close, updateOptions) is tearing the connection down:
      // a turn still in flight ends as a cancellation, not a failure.
      ctx.op?.markCancelled();
      ctx.waiter.reject(new APIConnectionError({ message: 'Connection closed' }));
    }
    this.#contexts.clear();
    if (this.#ws) {
      try {
        if (this.#ws.readyState === WebSocket.OPEN) {
          this.#ws.send(JSON.stringify({ close_socket: true }));
        }
        this.#ws.close();
      } catch {
        // KEEP-JUSTIFIED: best-effort socket teardown; the recv loop's finally
        // already rejected pending waiters, and a failed close has no recovery.
      }
      this.#ws = null;
    }
    await this.#sendTask?.catch(() => {});
    await this.#recvTask?.catch(() => {});
  }
}

/**
 * Block until the context's waiter settles, failing only when the server has
 * been silent for this context for longer than `idleThresholdMs`. Long
 * generations do not time out as long as frames keep arriving. Mirrors the
 * Python plugin's `_wait_for_context_idle`.
 */
export async function waitForContextIdle(
  ctx: ContextData,
  idleThresholdMs: number,
): Promise<void> {
  const tick = Math.min(1000, Math.max(100, idleThresholdMs / 4));
  for (;;) {
    const result = await Promise.race([
      ctx.waiter.promise.then(() => 'done' as const),
      delay(tick).then(() => 'tick' as const),
    ]);
    if (result === 'done') return;
    if (Date.now() - ctx.lastActivityAt >= idleThresholdMs) {
      throw new APITimeoutError({ message: 'timed out waiting for KugelAudio audio' });
    }
  }
}
