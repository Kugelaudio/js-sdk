/**
 * KugelAudio TTS plugin for the LiveKit Agents (Node.js) framework.
 *
 * A TypeScript translation of `kugelaudio.livekit.tts` (Python SDK). Uses a
 * single persistent WebSocket to `/ws/tts/multi` with per-call context IDs; the
 * shared connection multiplexes every context. On barge-in (the framework
 * aborting a stream) the context is closed with `immediate=true` and any late
 * server frames for it are silently discarded. A context's waiter resolves only
 * on the server's `context_closed` frame — sent after every audio frame has
 * been drained — so the audio tail is never clipped.
 */

import {
  APIError,
  APIConnectionError,
  APITimeoutError,
  type APIConnectOptions,
  log,
  shortuuid,
  tts,
} from '@livekit/agents';

import packageJson from '../../package.json';
import { Diagnostics, type Operation } from '../diagnostics';
import { authHeaders, clampCfgScale } from '../utils';
import { Mutex } from './mutex';
import { AudioSink } from './audioSink';
import {
  Connection,
  deferred,
  waitForContextIdle,
  type ResolvedTTSOptions,
} from './connection';
import {
  DEFAULT_CFG_SCALE,
  DEFAULT_MAX_NEW_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_VOICE_ID,
  type TTSModels,
  validateLanguage,
  validateSpeed,
  validateTemperature,
} from './models';

const NUM_CHANNELS = 1;

/** Options accepted by the {@link TTS} constructor. */
export interface TTSOptions {
  /**
   * KugelAudio API key. Falls back to the `KUGELAUDIO_API_KEY` environment
   * variable. Prefix with `"eu-"` to select the direct EU endpoint; the prefix
   * is stripped before auth.
   */
  apiKey?: string;
  /** TTS model. Defaults to `'kugel-3'`. */
  model?: TTSModels | string;
  /** Voice id. `null`/omitted uses the server default voice. */
  voiceId?: number | null;
  /** Output sample rate in Hz (24000, 22050, 16000, 8000). Defaults to 24000. */
  sampleRate?: number;
  /** Classifier-free guidance scale. Clamped to [1.2, 2.5]. Defaults to 2.0. */
  cfgScale?: number;
  /** Maximum tokens to generate. Defaults to 2048. */
  maxNewTokens?: number;
  /** Apply loudness normalization to the output audio. Defaults to true. */
  normalize?: boolean;
  /**
   * Request per-chunk word-level timestamps for aligned transcript / barge-in.
   * Defaults to false. Enabling advertises the `alignedTranscript` capability.
   */
  wordTimestamps?: boolean;
  /**
   * ISO 639-1 language code for text normalization (e.g. `'de'`). When unset,
   * the server uses the voice's primary language (English if none).
   */
  language?: string;
  /**
   * Playback speed multiplier (0.8 = slower, 1.0 = normal, 1.2 = faster),
   * applied with pitch-preserving time-stretching. Omitted leaves the server
   * default of 1.0.
   *
   * Range: **[0.8, 1.2]**. Values outside the band throw — the server rejects
   * them rather than clamping, so silently clamping here would synthesize at a
   * rate you never asked for.
   *
   * **Session-wide on `/ws/tts/multi`.** The plugin multiplexes every context
   * over one shared socket and the server applies `speed` to the whole
   * session, so it is last-writer-wins across contexts: a value set via
   * {@link TTS.updateOptions} binds for contexts started *after* the change,
   * not for ones already in flight. `updateOptions` marks the current
   * connection non-current for exactly this reason, so the next synthesis
   * opens a fresh session with the new speed.
   */
  speed?: number;
  /**
   * Sampling variance: `0` is the most stable read, `1` the most varied.
   * Omitted leaves the engine default.
   *
   * Range: **[0.0, 1.0]**. Values outside it throw; the server rejects them
   * rather than clamping. Session-wide on `/ws/tts/multi` with the same
   * last-writer-wins and connection-recycling semantics as {@link speed}.
   */
  temperature?: number;
  /**
   * Pronunciation dictionaries to apply, by id. Requires {@link projectId} —
   * the server rejects a selection without it.
   *
   * An empty array is NOT the same as omitting this: the server reads
   * `dictionary_ids: []` as an explicit opt-out from the project's defaults,
   * so it is only sent when non-empty.
   */
  dictionaryIds?: number[];
  /** Project the dictionaries belong to. Required whenever {@link dictionaryIds} is set. */
  projectId?: number;
  /** API base URL. Overrides the default geo-routed endpoint. */
  baseURL?: string;
  /**
   * Send anonymous client-error diagnostics (no text, audio, keys or URLs;
   * see the attribute allowlist in `diagnosticsWire.ts`).
   *
   * Defaults to enabled only for the KugelAudio-hosted API; a custom
   * `baseURL` (on-premise) defaults to disabled. The `KUGELAUDIO_TELEMETRY`
   * environment variable overrides this option in both directions.
   */
  telemetry?: boolean;
}

const DEFAULT_BASE_URL = 'https://api.kugelaudio.com';
const EU_BASE_URL = 'https://api.eu.kugelaudio.com';

/** Strip an `eu-`/`us-`/`global-` region prefix from an API key. */
function parseApiKey(apiKey: string): { cleanKey: string; region?: string } {
  for (const prefix of ['eu-', 'us-', 'global-']) {
    if (apiKey.startsWith(prefix)) {
      return { cleanKey: apiKey.slice(prefix.length), region: prefix.slice(0, -1) };
    }
  }
  return { cleanKey: apiKey };
}

/** Report a terminal failure when this plugin must stop the base retry loop. */
function reportTerminalError(instance: TTS, error: APIError): void {
  instance.emit('error', {
    type: 'tts_error',
    timestamp: Date.now(),
    label: instance.label,
    error,
    recoverable: false,
  });
}


/**
 * KugelAudio Text-to-Speech plugin for LiveKit Agents.
 *
 * @example
 * ```ts
 * import { TTS } from 'kugelaudio/livekit';
 * import { AgentSession } from '@livekit/agents';
 *
 * const session = new AgentSession({
 *   tts: new TTS({ voiceId: 1071, model: 'kugel-3', language: 'en' }),
 *   // ...stt, llm, vad
 * });
 * ```
 */
export class TTS extends tts.TTS {
  #opts: ResolvedTTSOptions;
  #streams = new Set<SynthesizeStream>();
  #currentConnection: Connection | null = null;
  #connectionLock = new Mutex();
  #diagnostics: Diagnostics;
  #shutdown = new AbortController();
  /** Connection acquisitions in flight; close() lets them settle first. */
  #acquiring = new Set<Promise<Connection>>();
  #logger = log();

  label = 'kugelaudio.TTS';

  constructor(opts: TTSOptions = {}) {
    const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const wordTimestamps = opts.wordTimestamps ?? false;

    super(sampleRate, NUM_CHANNELS, {
      streaming: true,
      alignedTranscript: wordTimestamps,
    });

    const apiKey = opts.apiKey ?? process.env.KUGELAUDIO_API_KEY;
    if (!apiKey) {
      throw new Error(
        'KUGELAUDIO_API_KEY must be set or apiKey must be provided to the TTS constructor.',
      );
    }

    const { cleanKey } = parseApiKey(apiKey);
    const language = validateLanguage(opts.language);
    const speed = validateSpeed(opts.speed);
    const temperature = validateTemperature(opts.temperature);

    let baseURL: string;
    if (opts.baseURL) {
      baseURL = opts.baseURL.replace(/\/$/, '');
    } else {
      const { region } = parseApiKey(apiKey);
      baseURL = region === 'eu' ? EU_BASE_URL : DEFAULT_BASE_URL;
    }

    this.#opts = {
      apiKey: cleanKey,
      baseURL,
      model: opts.model ?? DEFAULT_MODEL,
      voiceId: opts.voiceId ?? DEFAULT_VOICE_ID,
      sampleRate,
      cfgScale: clampCfgScale(opts.cfgScale ?? DEFAULT_CFG_SCALE) ?? DEFAULT_CFG_SCALE,
      maxNewTokens: opts.maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS,
      wordTimestamps,
      normalize: opts.normalize ?? true,
      language,
      speed,
      temperature,
      // A selection without a project is rejected by the server, so refuse it
      // here rather than letting every synthesis fail with a wire error that
      // does not name the missing field.
      ...(opts.dictionaryIds?.length ? { dictionaryIds: opts.dictionaryIds } : {}),
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    };

    if (this.#opts.dictionaryIds && this.#opts.projectId === undefined) {
      throw new Error(
        'KugelAudio TTS: dictionaryIds requires projectId — the server rejects a dictionary selection without its project.',
      );
    }

    this.#diagnostics = new Diagnostics({
      apiUrl: baseURL,
      sdkVersion: packageJson.version,
      // Same host, same credentials as every other SDK call: the plugin's
      // socket authenticates by query parameter, but the diagnostics POST is
      // ordinary authenticated HTTP.
      authHeaders: authHeaders(cleanKey),
      telemetry: opts.telemetry,
      integration: 'livekit',
    });
  }

  /**
   * Client-error diagnostics reporter (integration `livekit`).
   * @internal
   */
  get diagnostics(): Diagnostics {
    return this.#diagnostics;
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'KugelAudio';
  }

  /**
   * Get or create the persistent `/ws/tts/multi` connection.
   *
   * `timeoutMs` bounds the **total** acquisition time — waiting for the
   * connection lock *plus* the WebSocket handshake — not just the handshake.
   * Without that, a caller passing 2500ms could sit behind an in-flight
   * `prewarm()` holding the lock for its own (longer) connect and only then
   * start its 2.5s handshake, blowing far past the budget it asked for.
   *
   * @throws {APITimeoutError} If the budget expires waiting for the lock or
   *   during the handshake.
   */
  currentConnection(timeoutMs = 10_000, abortSignal?: AbortSignal): Promise<Connection> {
    const acquisition = this.#acquireConnection(timeoutMs, abortSignal);
    this.#acquiring.add(acquisition);
    const forget = () => { this.#acquiring.delete(acquisition); };
    acquisition.then(forget, forget);
    return acquisition;
  }

  async #acquireConnection(timeoutMs: number, abortSignal?: AbortSignal): Promise<Connection> {
    this.#shutdown.signal.throwIfAborted();
    abortSignal?.throwIfAborted();
    const scope = new AbortController();
    const signal = scope.signal;
    const shutdown = () => scope.abort(this.#shutdown.signal.reason);
    const cancel = () => scope.abort(abortSignal!.reason);
    this.#shutdown.signal.addEventListener('abort', shutdown, { once: true });
    abortSignal?.addEventListener('abort', cancel, { once: true });
    const started = performance.now();
    const deadline = started + timeoutMs;
    let unlock: (() => void) | undefined;
    try {
      unlock = await this.#connectionLock.lock(timeoutMs, signal);
      signal.throwIfAborted();
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        throw new APITimeoutError({ message: `Timed out after ${timeoutMs}ms acquiring a KugelAudio connection` });
      }
      if (
        this.#currentConnection &&
        this.#currentConnection.isCurrent &&
        !this.#currentConnection.closed
      ) {
        return this.#currentConnection;
      }
      const conn = new Connection({ ...this.#opts }, this.#diagnostics);
      try {
        await conn.connect(remainingMs, signal);
        signal.throwIfAborted();
      } catch (error) {
        // `connect()` already settled the diagnostics operation on its own
        // failure path; `close()` is a no-op for an already-failed connection.
        await conn.close();
        if (error instanceof APITimeoutError) {
          throw new APITimeoutError({ message: `${error.message}; acquisition budget ${timeoutMs}ms, lock wait ${Math.round(timeoutMs - remainingMs)}ms` });
        }
        throw error;
      }
      this.#currentConnection = conn;
      return conn;
    } finally {
      unlock?.();
      this.#shutdown.signal.removeEventListener('abort', shutdown);
      abortSignal?.removeEventListener('abort', cancel);
    }
  }

  /**
   * Eagerly establish the WebSocket connection to remove handshake latency
   * from the first synthesis. Errors are logged and retried on first use.
   *
   * @param timeoutMs - Total budget for the pre-warm. Defaults to 10s. The
   *   connection lock is only held for this long, so a synthesis call that
   *   arrives during a pre-warm is bounded by its own `connOptions.timeoutMs`
   *   rather than by this one.
   */
  prewarm(timeoutMs = 10_000): void {
    this.currentConnection(timeoutMs)
      .then(() => this.#logger.info('KugelAudio TTS connection pre-warmed'))
      .catch((err) =>
        this.#logger.warn(
          { error: err },
          'Failed to prewarm KugelAudio connection; will retry on first synthesis',
        ),
      );
  }

  /**
   * Update TTS options at runtime. Changing any option marks the current
   * connection non-current so the next synthesis opens a fresh one.
   *
   * That reconnect is what makes a `speed` change safe: `/ws/tts/multi`
   * applies `speed` session-wide (last-writer-wins across the contexts
   * sharing the socket), so a new value must not be injected into a live
   * session — it binds for contexts started after the change.
   *
   * `temperature` is session-wide in exactly the same way.
   *
   * @throws {Error} If `speed` is outside [0.8, 1.2], `temperature` is
   *   outside [0.0, 1.0], or `language` is not a supported ISO 639-1 code.
   *   Validation runs before any option is applied, so a rejected call
   *   leaves the instance untouched.
   */
  updateOptions(opts: Partial<Omit<TTSOptions, 'apiKey' | 'baseURL'>>): void {
    // Validate up front: a throw halfway through would leave a half-applied
    // option set on a connection that never gets recycled.
    const speed = opts.speed !== undefined ? validateSpeed(opts.speed) : undefined;
    const temperature =
      opts.temperature !== undefined ? validateTemperature(opts.temperature) : undefined;
    const language = opts.language !== undefined ? validateLanguage(opts.language) : undefined;

    let changed = false;
    const set = <K extends keyof ResolvedTTSOptions>(key: K, value: ResolvedTTSOptions[K]) => {
      if (this.#opts[key] !== value) {
        this.#opts[key] = value;
        changed = true;
      }
    };

    if (opts.model !== undefined) set('model', opts.model);
    if (opts.voiceId !== undefined) set('voiceId', opts.voiceId);
    if (opts.cfgScale !== undefined) {
      set('cfgScale', clampCfgScale(opts.cfgScale) ?? DEFAULT_CFG_SCALE);
    }
    if (opts.maxNewTokens !== undefined) set('maxNewTokens', opts.maxNewTokens);
    if (opts.normalize !== undefined) set('normalize', opts.normalize);
    if (opts.wordTimestamps !== undefined) set('wordTimestamps', opts.wordTimestamps);
    if (opts.dictionaryIds !== undefined) set('dictionaryIds', opts.dictionaryIds);
    if (opts.projectId !== undefined) set('projectId', opts.projectId);
    if (opts.language !== undefined) set('language', language);
    if (opts.speed !== undefined) set('speed', speed);
    if (opts.temperature !== undefined) set('temperature', temperature);

    if (changed && this.#currentConnection) {
      const old = this.#currentConnection;
      old.markNonCurrent();
      this.#currentConnection = null;
      old.close().catch(() => {});
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(this, text, { ...this.#opts }, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    const stream = new SynthesizeStream(this, { ...this.#opts }, options?.connOptions);
    this.#streams.add(stream);
    // The framework closes (aborts) every stream when its speech turn ends;
    // drop our reference then so a long-lived session doesn't accumulate one
    // entry per turn.
    stream.abortSignal.addEventListener('abort', () => this.#streams.delete(stream), {
      once: true,
    });
    return stream;
  }

  async close(): Promise<void> {
    this.#shutdown.abort(new APIConnectionError({ message: 'KugelAudio TTS is closed' }));
    for (const stream of this.#streams) stream.close();
    this.#streams.clear();
    // The abort above settles any connect in flight as a cancellation; wait
    // for that before sdk_stats snapshots the counters.
    await Promise.allSettled([...this.#acquiring]);
    if (this.#currentConnection) {
      await this.#currentConnection.close();
      this.#currentConnection = null;
    }
    // Emits sdk_stats; bounded to 1 s and never holds the process open.
    await this.#diagnostics.close();
  }
}

/** Non-streaming (one-shot) synthesis over the shared `/ws/tts/multi` connection. */
export class ChunkedStream extends tts.ChunkedStream {
  #tts: TTS;
  #opts: ResolvedTTSOptions;
  #connOptions: APIConnectOptions;
  #attempts = 0;
  /**
   * One diagnostics operation for the whole synthesis, across LiveKit's
   * retries of `run()`: minted once a connection is in hand (acquisition
   * failures are the connection's own operation), settled when the stream
   * succeeds, is aborted, or fails for good.
   */
  #op: Operation | null = null;

  label = 'kugelaudio.ChunkedStream';

  constructor(
    ttsInstance: TTS,
    text: string,
    opts: ResolvedTTSOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.#tts = ttsInstance;
    this.#opts = opts;
    this.#connOptions = connOptions ?? { maxRetry: 3, retryIntervalMs: 2000, timeoutMs: 10000 };
  }

  protected async run(): Promise<void> {
    this.#attempts += 1;
    if (this.#attempts > 1) this.#op?.markRetry();
    try {
      await this.#runAttempt();
      if (this.abortController.signal.aborted) this.#op?.cancel();
      else this.#op?.succeed();
    } catch (error) {
      if (this.abortController.signal.aborted) {
        this.#op?.cancel();
        return;
      }
      const willRetry =
        error instanceof APIError
        && error.retryable
        && this.#attempts <= this.#connOptions.maxRetry;
      if (!willRetry) this.#op?.fail(error);
      if (!(error instanceof APIError) || willRetry) throw error;
      // LiveKit's private mainTask rethrows terminal errors into an unowned
      // promise. Keep its retry policy for nonfinal attempts, but report the
      // terminal API error here so its queue closes without an unhandled reject.
      reportTerminalError(this.#tts, error);
    }
  }

  async #runAttempt(): Promise<void> {
    const contextId = shortuuid();
    const connection = await this.#tts.currentConnection(this.#connOptions.timeoutMs, this.abortController.signal);
    if (this.abortController.signal.aborted) return;
    this.#op ??= this.#tts.diagnostics.startOperation('multi_context', 'websocket');
    const sink = new AudioSink(this.#opts.sampleRate, (a) => this.queue.put(a), contextId, contextId);
    const waiter = deferred();
    const ctx = connection.registerContext(contextId, sink, waiter, false, this.#op);
    if (!ctx) {
      await waiter.promise; // register rejected — surface the error.
      return;
    }

    const onAbort = () => waiter.reject(new Error('aborted'));
    this.abortController.signal.addEventListener('abort', onAbort, { once: true });

    try {
      connection.sendText(contextId, this.inputText, true);
      await waitForContextIdle(ctx, this.#connOptions.timeoutMs);
    } catch (err) {
      connection.closeContext(contextId, true);
      connection.cleanupContext(contextId);
      if (this.abortController.signal.aborted) return;
      throw err;
    } finally {
      this.abortController.signal.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Streaming synthesis: text tokens are pushed via the LiveKit input channel and
 * forwarded to the shared connection; audio is routed back by `context_id`.
 */
export class SynthesizeStream extends tts.SynthesizeStream {
  #tts: TTS;
  #opts: ResolvedTTSOptions;
  #contextId: string | undefined;

  label = 'kugelaudio.SynthesizeStream';

  constructor(ttsInstance: TTS, opts: ResolvedTTSOptions, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.#tts = ttsInstance;
    this.#opts = opts;
  }

  /** The server-side context id of the current (latest) run attempt. */
  get contextId(): string | undefined {
    return this.#contextId;
  }

  protected async run(): Promise<void> {
    // Fresh id per attempt: the base class retries run() on retryable API
    // errors, and a retried attempt must not collide with the failed
    // attempt's server-side context (mirrors the Python plugin's per-_run id).
    const contextId = shortuuid();
    this.#contextId = contextId;
    const timeoutMs = this.connOptions.timeoutMs;
    let connection: Connection;
    try {
      connection = await this.#tts.currentConnection(timeoutMs, this.abortController.signal);
    } catch (error) {
      if (this.abortController.signal.aborted) return;
      throw error;
    }
    if (this.abortController.signal.aborted) return;
    // One operation per turn. Once the input reader starts, a failure is
    // terminal (see below), so a run() that gets this far is the whole turn.
    const op = this.#tts.diagnostics.startOperation('multi_context', 'websocket');
    const sink = new AudioSink(this.#opts.sampleRate, (a) => this.queue.put(a), contextId, contextId);
    const waiter = deferred();
    const ctx = connection.registerContext(contextId, sink, waiter, true, op);
    if (!ctx) {
      await waiter.promise; // register rejected — surface the error.
      return;
    }

    const onAbort = () => waiter.reject(new Error('aborted'));
    this.abortController.signal.addEventListener('abort', onAbort, { once: true });

    // Cancellation handle for the input loop — the JS equivalent of the
    // Python plugin's `gracefully_cancel(input_t)`. Without it, an error or
    // timeout would leave run() blocked on the input channel until the LLM
    // finishes its turn, while the loop keeps re-creating the dead context
    // server-side (wasted GPU on audio nobody consumes).
    const STOP = Symbol('stop');
    const stopInput = deferred();
    let failed = false;

    const inputTask = async () => {
      for (;;) {
        const result = await Promise.race([
          this.input.next(),
          stopInput.promise.then(() => STOP),
        ]);
        if (typeof result === 'symbol') return; // STOP

        if (result.done) break;
        if (this.abortController.signal.aborted || failed) return;
        const data = result.value;
        if (data === SynthesizeStream.FLUSH_SENTINEL) {
          connection.sendText(contextId, '', true);
          continue;
        }
        if (!data) continue;
        connection.sendText(contextId, data, false);
      }
      // Input channel closed. On a normal end-of-input, flush and close the
      // context gracefully so the tail drains. On barge-in (abort) or failure
      // the catch below issues an immediate close instead.
      if (!this.abortController.signal.aborted && !failed) {
        connection.sendText(contextId, '', true);
        connection.closeContext(contextId, false);
      }
    };

    const input = inputTask();
    // Surface an input-side failure onto the waiter so run() doesn't hang.
    input.catch((err) => waiter.reject(err instanceof Error ? err : new Error(String(err))));

    try {
      await waitForContextIdle(ctx, timeoutMs);
      if (this.abortController.signal.aborted) op.cancel();
      else op.succeed();
    } catch (err) {
      failed = true;
      // Barge-in is the caller cancelling this turn; anything else failed it.
      if (this.abortController.signal.aborted) op.cancel();
      else op.fail(err);
      connection.closeContext(contextId, true);
      connection.cleanupContext(contextId);
      if (this.abortController.signal.aborted) return;
      if (err instanceof APIError) {
        // Once the reader starts, a retry cannot replay consumed text or cancel
        // its pending input.next(). Report failure instead of losing input to
        // an empty retry or an abandoned reader; acquisition can still retry.
        reportTerminalError(this.#tts, err);
        return;
      }
      throw err;
    } finally {
      this.abortController.signal.removeEventListener('abort', onAbort);
      stopInput.resolve();
      await input.catch(() => {});
    }
  }
}
