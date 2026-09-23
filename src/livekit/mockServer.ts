/**
 * In-process mock of the KugelAudio `/ws/tts/multi` endpoint, shared by the
 * LiveKit plugin's functional tests.
 *
 * It speaks the real ingress wire protocol (see
 * `services/ingress/src/ingress/routes/ws_multi.py`):
 *
 *  - first message of a context carries `model_id` / `sample_rate` / config
 *  - `flush: true` triggers audio frames + `chunk_complete`
 *  - `{close_context}` is answered with `{context_closed}` (terminal)
 *  - `immediate: true` close cancels without draining
 *
 * Test-only helper: it is not exported from `src/livekit/index.ts` and never
 * reaches the published bundle.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket as ServerWebSocket } from 'ws';

/** 100ms of 16-bit mono PCM at 24kHz. */
export const FRAME_BYTES = 4800;

export interface MockContextState {
  text: string;
  configMessages: Record<string, unknown>[];
  closed: boolean;
  immediateClose: boolean;
}

/**
 * Minimal implementation of the `/ws/tts/multi` protocol. Each flush emits
 * `audioFramesPerFlush` PCM frames followed by `chunk_complete`;
 * `close_context` drains (unless immediate) and answers `context_closed`.
 *
 * `blackHole` additionally simulates a dead API that still completes the TCP
 * handshake: the upgrade request is parked and never answered, so the client's
 * WebSocket handshake hangs until its own timeout fires.
 */
export class MockMultiServer {
  server: Server;
  wss: WebSocketServer;
  connectionCount = 0;
  contexts = new Map<string, MockContextState>();
  messages: Record<string, unknown>[] = [];
  audioFramesPerFlush = 2;
  /** Extra sub-frame PCM bytes sent after the full frames of each flush. */
  tailBytesPerFlush = 0;
  /** When set, the first text message of a context is answered with this error frame. */
  errorFrame: Record<string, unknown> | null = null;
  /** When true, never respond to anything (for idle-timeout tests). */
  silent = false;
  /**
   * When true, accept the TCP connection but never complete the WebSocket
   * handshake — the "dead API" a caller's own `timeoutMs` must bound.
   */
  blackHole = false;
  /** Upgrade sockets parked by {@link blackHole} mode. */
  heldSockets: Duplex[] = [];
  /** `Date.now()` of each parked handshake socket's teardown. */
  abortedHandshakes: number[] = [];

  constructor() {
    this.server = createServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
      if (!req.url?.startsWith('/ws/tts/multi')) {
        socket.destroy();
        return;
      }
      if (this.blackHole) {
        this.heldSockets.push(socket);
        // The upgrade socket is handed over paused; without resuming it the
        // client's FIN is never read and no teardown event fires. Note only
        // 'end' arrives when the client aborts (the connection is half-open
        // until we destroy our side), so 'close' alone would never fire.
        socket.resume();
        let recorded = false;
        const recordTeardown = () => {
          if (recorded) return;
          recorded = true;
          this.abortedHandshakes.push(Date.now());
        };
        socket.on('end', recordTeardown);
        socket.on('close', recordTeardown);
        socket.on('error', () => {
          // KEEP-JUSTIFIED: test double; a parked socket reset by the client's
          // handshake timeout has nowhere to report to and must not crash the
          // test process. The 'close' handler above records the teardown.
        });
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });
    this.wss.on('connection', (ws) => {
      this.connectionCount += 1;
      ws.on('message', (raw) => this.onMessage(ws, JSON.parse(raw.toString())));
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Tear down every parked handshake so the client's connect fails at once. */
  destroyHeldSockets(): void {
    for (const socket of this.heldSockets.splice(0)) socket.destroy();
  }

  async close(): Promise<void> {
    this.destroyHeldSockets();
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onMessage(ws: ServerWebSocket, msg: Record<string, unknown>): void {
    this.messages.push(msg);
    if (this.silent) return;

    if (msg.close_socket) {
      ws.send(JSON.stringify({ session_closed: true }));
      ws.close();
      return;
    }

    const contextId = msg.context_id as string;

    if (msg.close_context) {
      const ctx = this.contexts.get(contextId);
      if (ctx) {
        ctx.closed = true;
        ctx.immediateClose = Boolean(msg.immediate);
      }
      ws.send(JSON.stringify({ context_closed: true, context_id: contextId }));
      return;
    }

    let ctx = this.contexts.get(contextId);
    if (!ctx) {
      ctx = { text: '', configMessages: [], closed: false, immediateClose: false };
      this.contexts.set(contextId, ctx);
      ws.send(JSON.stringify({ context_created: true, context_id: contextId }));
    }
    if (msg.model_id !== undefined) ctx.configMessages.push(msg);
    if (typeof msg.text === 'string') ctx.text += msg.text;

    if (msg.flush) {
      if (this.errorFrame) {
        ws.send(JSON.stringify({ ...this.errorFrame, context_id: contextId }));
        this.contexts.delete(contextId);
        return;
      }
      if (ctx.text.length > 0) {
        for (let i = 0; i < this.audioFramesPerFlush; i++) {
          const pcm = Buffer.alloc(FRAME_BYTES, i + 1);
          ws.send(JSON.stringify({ audio: pcm.toString('base64'), context_id: contextId }));
        }
        if (this.tailBytesPerFlush > 0) {
          const tail = Buffer.alloc(this.tailBytesPerFlush, 0x7f);
          ws.send(JSON.stringify({ audio: tail.toString('base64'), context_id: contextId }));
        }
        ws.send(
          JSON.stringify({
            word_timestamps: [{ word: 'hello', start_ms: 0, end_ms: 500 }],
            context_id: contextId,
          }),
        );
        ws.send(JSON.stringify({ chunk_complete: true, context_id: contextId }));
        ctx.text = '';
      }
    }
  }
}
