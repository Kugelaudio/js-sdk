/**
 * `client.enhance.session()`: several streams over one warm WebSocket.
 *
 * Runs the SDK's real WebSocket (`ws`) against a local `ws` server that speaks
 * the enhancement stream protocol, in session mode when the URL carries
 * `session=1`, and counts the connections it accepts.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import { KugelAudio } from './client';
import { RateLimitError } from './errors';

interface SessionServer {
  url: string;
  connections: number;
  open: number;
  handshakeDelayMs: number;
  paths: string[];
  configs: Record<string, unknown>[];
  supportsSessions: boolean;
  closeAfterAudio: number | null;
  idleFrameAfterMs: number | null;
  refuseSessions: { status: number; headers: Record<string, string> } | null;
  rateLimitedConfigs: Set<number>;
  close: () => Promise<void>;
}

async function sessionServer(): Promise<SessionServer> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const state: SessionServer = {
    url: '',
    connections: 0,
    open: 0,
    handshakeDelayMs: 0,
    paths: [],
    configs: [],
    supportsSessions: true,
    closeAfterAudio: null,
    idleFrameAfterMs: null,
    refuseSessions: null,
    rateLimitedConfigs: new Set(),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
  http.on('upgrade', async (request, socket, head) => {
    if (state.handshakeDelayMs) await new Promise((resolve) => setTimeout(resolve, state.handshakeDelayMs));
    const refusal = state.refuseSessions;
    if (refusal && request.url?.includes('session=1')) {
      const body = JSON.stringify({ error: 'Open session limit reached (2)', error_code: 'RATE_LIMITED', code: refusal.status });
      const headers = Object.entries({ 'content-type': 'application/json', 'content-length': String(body.length), ...refusal.headers })
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('');
      socket.end(`HTTP/1.1 ${refusal.status} Refused\r\n${headers}\r\n${body}`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => serve(ws, request.url ?? ''));
  });

  function serve(ws: ServerSocket, path: string): void {
    state.connections += 1;
    state.open += 1;
    ws.on('close', () => {
      state.open -= 1;
    });
    state.paths.push(path);
    const session = path.includes('session=1') && state.supportsSessions;
    let audioId: string | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (state.idleFrameAfterMs === null) return;
      idle = setTimeout(() => {
        ws.send(JSON.stringify({ type: 'error', error: 'no audio received for 30 seconds', error_code: 'VALIDATION_ERROR', code: 408, request_id: 'idle' }));
        ws.close(4000);
      }, state.idleFrameAfterMs);
    };
    armIdle();
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.send(Buffer.from(data as Buffer).reverse());
        return;
      }
      const message = JSON.parse(String(data));
      if (message.type === 'close') {
        ws.close(1000);
        return;
      }
      if (message.type === 'config') {
        clearTimeout(idle);
        state.configs.push(message);
        const number = state.configs.length;
        audioId = `audio-${number}`;
        if (state.rateLimitedConfigs.has(number)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Rate limit exceeded (1 requests per minute)', error_code: 'RATE_LIMITED', code: 429, request_id: audioId, retry_after: 3 }));
          return;
        }
        ws.send(JSON.stringify({ type: 'ready', sample_rate_hz: 24000, encoding: 'pcm_s16le', ...(session ? { request_id: audioId } : {}) }));
        return;
      }
      if (message.type === 'end') {
        ws.send(JSON.stringify({ type: 'done', duration_s: 0.1, ...(session ? { request_id: audioId } : {}) }));
        if (!session) ws.close(1000);
        else if (state.closeAfterAudio !== null) ws.close(state.closeAfterAudio);
      }
    });
    ws.on('close', () => clearTimeout(idle));
  }

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  state.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return state;
}

const CHUNK = new Uint8Array([1, 0, 2, 0]);
const REVERSED = [0, 2, 0, 1];

async function enhance(
  session: ReturnType<KugelAudio['enhance']['session']>,
  rate = 16000,
): Promise<number[][]> {
  const out: number[][] = [];
  for await (const chunk of session.stream([CHUNK], { model: 'clarity-1', sampleRate: rate })) out.push([...chunk]);
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(5);
  }
}

describe('client.enhance.session', () => {
  let server: SessionServer;
  let client: KugelAudio;

  const setup = async () => {
    server = await sessionServer();
    client = new KugelAudio({ apiKey: 'sk-test', apiUrl: server.url });
  };

  afterEach(async () => {
    await server?.close();
  });

  it('carries many streams on one socket', async () => {
    await setup();
    const session = client.enhance.session();
    for (let i = 0; i < 4; i++) expect(await enhance(session)).toEqual([REVERSED]);
    await session.close();
    expect(server.connections).toBe(1);
    expect(server.configs).toHaveLength(4);
    expect(server.paths[0]).toContain('session=1');
  });

  it('connect() opens the socket before the first audio', async () => {
    await setup();
    const session = client.enhance.session();
    await session.connect();
    await waitFor(() => server.connections === 1);
    expect(server.configs).toEqual([]);
    await session.connect(); // reuses the open socket
    expect(await enhance(session)).toEqual([REVERSED]);
    await session.close();
    expect(server.connections).toBe(1);
  });

  it('sends a new config for a new sample rate on the same socket', async () => {
    await setup();
    const session = client.enhance.session();
    await enhance(session, 16000);
    await enhance(session, 48000);
    await session.close();
    expect(server.configs.map((c) => c.sample_rate_hz)).toEqual([16000, 48000]);
    expect(server.connections).toBe(1);
  });

  it('replaces a socket the server closed (restart 1012) without an error', async () => {
    await setup();
    server.closeAfterAudio = 1012;
    const session = client.enhance.session();
    for (let i = 0; i < 3; i++) expect(await enhance(session)).toEqual([REVERSED]);
    await session.close();
    expect(server.connections).toBe(3);
  });

  it("replaces a socket an old server closed for idling, without an error", async () => {
    await setup();
    server.supportsSessions = false;
    server.idleFrameAfterMs = 30;
    const session = client.enhance.session();
    await session.connect();
    await sleep(150); // the server sent its 408 frame and closed
    expect(await enhance(session)).toEqual([REVERSED]);
    await session.close();
    expect(server.connections).toBe(2);
  });

  it('uses one connection per stream against a server without sessions', async () => {
    await setup();
    server.supportsSessions = false;
    const session = client.enhance.session();
    for (let i = 0; i < 3; i++) expect(await enhance(session)).toEqual([REVERSED]);
    await session.close();
    expect(server.connections).toBe(3);
    expect(server.paths.map((p) => p.includes('session=1'))).toEqual([true, false, false]);
  });

  it('streams on a connection of its own when the session is refused (open-session limit)', async () => {
    await setup();
    server.refuseSessions = { status: 429, headers: {} };
    const session = client.enhance.session();
    expect(await enhance(session)).toEqual([REVERSED]);
    await session.close();
    expect(server.connections).toBe(1);
    expect(server.paths[0]).not.toContain('session=1');
  });

  it('keeps the socket after a rate-limited config', async () => {
    await setup();
    server.rateLimitedConfigs = new Set([2]);
    const session = client.enhance.session();
    await enhance(session);
    const refused = await enhance(session).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RateLimitError);
    expect((refused as RateLimitError).retryAfter).toBe(3);
    expect(await enhance(session)).toEqual([REVERSED]);
    await session.close();
    expect(server.connections).toBe(1);
  });

  it('closes the socket when the caller stops iterating, and reconnects for the next stream', async () => {
    await setup();
    const session = client.enhance.session();
    async function* endless() {
      for (;;) {
        await sleep(5);
        yield CHUNK;
      }
    }
    for await (const _ of session.stream(endless(), { model: 'clarity-1', sampleRate: 16000 })) break;
    expect(await enhance(session)).toEqual([REVERSED]);
    await session.close();
    expect(server.connections).toBe(2);
  });

  it('close() during an un-awaited connect() leaves no socket open', async () => {
    await setup();
    server.handshakeDelayMs = 300;
    const session = client.enhance.session();
    const connecting = session.connect().catch((error: unknown) => error);
    await sleep(100); // the handshake is in flight
    await session.close();
    expect(await connecting).toBeInstanceOf(Error);
    expect(String(await connecting)).toContain('session is closed');
    await sleep(300);
    expect(server.open).toBe(0);
  });

  it('close() during the connect of a stream ends it with the closed error', async () => {
    await setup();
    server.handshakeDelayMs = 300;
    const session = client.enhance.session();
    const streaming = enhance(session).catch((error: unknown) => error);
    await sleep(100);
    await session.close();
    expect(String(await streaming)).toContain('session is closed');
    await sleep(300);
    expect(server.open).toBe(0);
    expect(server.configs).toEqual([]);
  });

  it('never puts the API key in the error for a bad API URL', async () => {
    const bad = new KugelAudio({ apiKey: 'sk-secret-key', apiUrl: 'http://[bad' });
    const failure = await enhance(bad.enhance.session()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('sk-secret-key');
    expect(String((failure as { cause?: unknown }).cause ?? '')).not.toContain('sk-secret-key');
  });

  it('refuses to stream after close()', async () => {
    await setup();
    const session = client.enhance.session();
    await session.close();
    await expect(enhance(session)).rejects.toThrow('session is closed');
  });

  it('leaves the one-shot stream without session=1', async () => {
    await setup();
    const out: number[][] = [];
    for await (const chunk of client.enhance.stream([CHUNK], { model: 'clarity-1', sampleRate: 16000 })) out.push([...chunk]);
    expect(out).toEqual([REVERSED]);
    expect(server.paths[0]).not.toContain('session=1');
  });
});
