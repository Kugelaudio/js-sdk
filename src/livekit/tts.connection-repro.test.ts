/**
 * Reproduce the September 7 connection symptoms using real loopback sockets.
 *
 * Run: npm test -- src/livekit/tts.connection-repro.test.ts
 * Covers locally reproduced defects, not the cause of the customer's incident.
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { APITimeoutError, initializeLogger } from '@livekit/agents';
import { WebSocketServer } from 'ws';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TTS } from './tts';
import { KugelAudio } from '../client';

const cleanup: Array<() => void | Promise<void>> = [];

beforeAll(() => initializeLogger({ pretty: false, level: 'silent' }));

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Own every transport, including those the SDK loses on failure/shutdown. */
async function endpoint() {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<Socket>();
  const clients: TTS[] = [];
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('end', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).close_socket) ws.close();
    });
  });
  cleanup.push(async () => {
    // Release held handshakes before awaiting the SDK's background loops.
    for (const ws of wss.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    for (const client of clients) await client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server, wss, sockets, baseURL,
    client() {
      const client = new TTS({ apiKey: 'local-test-key', baseURL });
      clients.push(client);
      return client;
    },
  };
}

describe('standalone JavaScript SDK counterparts', () => {
  it.each(['pooled', 'streaming', 'multi'] as const)('%s bounds a withheld handshake', async (kind) => {
    const host = await endpoint();
    host.server.on('upgrade', (_req, socket) => socket.resume());
    const client = new KugelAudio({ apiKey: 'local-test-key', apiUrl: host.baseURL, timeout: 200 });
    cleanup.push(() => client.close());
    const session = kind === 'multi' ? client.tts.createMultiContextSession({})
      : kind === 'streaming' ? client.tts.streamingSession({}, {}) : null;
    const attempt = session ? session.connect({}) : client.connect();
    const result = await Promise.race([
      attempt.then(() => 'opened', () => 'rejected'),
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('unbounded'), 800);
        cleanup.push(() => clearTimeout(timer));
      }),
    ]);
    expect(result).toBe('rejected');
  });

  it.each(['pooled', 'streaming', 'multi'] as const)('%s closes a pending handshake', async (kind) => {
    const host = await endpoint();
    const client = new KugelAudio({ apiKey: 'local-test-key', apiUrl: host.baseURL });
    cleanup.push(() => client.close());
    host.server.on('upgrade', (_req, socket) => socket.resume());
    const session = kind === 'multi' ? client.tts.createMultiContextSession({})
      : kind === 'streaming' ? client.tts.streamingSession({}, {}) : null;
    const received = once(host.server, 'upgrade');
    const connecting = expect(session ? session.connect({}) : client.connect()).rejects.toThrow();
    await received;
    if (session) await session.close(); else client.close();
    await connecting;
    await expect.poll(() => host.sockets.size).toBe(0);
  });

  it('shares one pending pooled handshake across callers', async () => {
    const host = await endpoint();
    const client = new KugelAudio({ apiKey: 'local-test-key', apiUrl: host.baseURL });
    cleanup.push(() => client.close());
    let requests = 0;
    host.server.on('upgrade', (req, socket, head) => {
      requests++;
      host.wss.handleUpgrade(req, socket, head, (ws) => host.wss.emit('connection', ws, req));
    });
    await Promise.all(Array.from({ length: 8 }, () => client.connect()));
    expect(requests).toBe(1);
  });
});

describe('connection lifecycle regressions', () => {
  it('cancels a queued caller without aborting the connection owner', async () => {
    const host = await endpoint();
    const client = host.client();
    const received = once(host.server, 'upgrade');
    const connecting = client.currentConnection(2_000);
    const [req, socket, head] = await received;
    const abort = new AbortController();
    const queued = expect(client.currentConnection(1_000, abort.signal)).rejects.toThrow('caller canceled');
    abort.abort(new Error('caller canceled'));
    await queued;
    host.wss.handleUpgrade(req, socket, head, (ws) => host.wss.emit('connection', ws, req));
    const connection = await connecting;
    expect(await client.currentConnection()).toBe(connection);
    expect(host.wss.clients.size).toBe(1);
  });

  it('aborts an owned pending handshake and allows the next caller to connect', async () => {
    const host = await endpoint();
    const client = host.client();
    const received = once(host.server, 'upgrade');
    const abort = new AbortController();
    const connecting = expect(client.currentConnection(2_000, abort.signal)).rejects.toThrow('caller canceled');
    const [, socket] = await received;
    socket.resume();
    abort.abort(new Error('caller canceled'));
    await connecting;
    await expect.poll(() => host.sockets.size).toBe(0);
    host.server.on('upgrade', (req, sock, head) => {
      host.wss.handleUpgrade(req, sock, head, (ws) => host.wss.emit('connection', ws, req));
    });
    expect((await client.currentConnection(1_000)).closed).toBe(false);
  });

  it('rejects every queued acquisition and future reuse after shutdown', async () => {
    const host = await endpoint();
    const client = host.client();
    const received = once(host.server, 'upgrade');
    const connecting = expect(client.currentConnection(2_000)).rejects.toThrow('closed');
    const [, socket] = await received;
    socket.resume();
    const queued = Array.from({ length: 3 }, () => expect(client.currentConnection(5_000)).rejects.toThrow('closed'));
    await client.close();
    await Promise.all([connecting, ...queued]);
    await expect(client.currentConnection()).rejects.toThrow('closed');
    await expect.poll(() => host.sockets.size).toBe(0);
  });
  it('cancels pending establishment when TTS.close() returns', async () => {
    const host = await endpoint();
    const client = host.client();
    const received = once(host.server, 'upgrade');
    const connecting = client.currentConnection(2_000).then(
      (connection) => ({ connection, error: null }),
      (error: unknown) => ({ connection: null, error }),
    );
    const [req, socket, head] = await received;
    socket.resume();
    await client.close();
    // Deliver the delayed upgrade only after the owner has closed.
    if (!socket.destroyed) {
      host.wss.handleUpgrade(req, socket, head, (ws) => {
        host.wss.emit('connection', ws, req);
      });
    }
    const result = await connecting;
    console.info('close during connect', {
      acquisitionSucceededAfterClose: result.connection !== null,
      connectionClosed: result.connection?.closed,
      serverOpenWebSockets: host.wss.clients.size,
    });
    expect(result.error, 'closed TTS must reject pending acquisition').toBeTruthy();
  });

  it('enforces the total deadline even when response headers keep arriving', async () => {
    const host = await endpoint();
    host.server.on('upgrade', (_req, socket) => {
      socket.resume();
      socket.write('HTTP/1.1 503 Service Unavailable\r\n');
      const trickle = setInterval(() => socket.write('X-Progress: waiting\r\n'), 40);
      const finish = setTimeout(() => {
        clearInterval(trickle);
        socket.end('\r\n');
      }, 1_200);
      const stop = () => { clearInterval(trickle); clearTimeout(finish); };
      socket.once('close', stop);
      cleanup.push(stop);
    });
    const started = performance.now();
    const result = await host.client().currentConnection(200).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    const elapsedMs = Math.round(performance.now() - started);
    console.info('trickling handshake', {
      budgetMs: 200,
      elapsedMs,
      error: result.error instanceof Error ? result.error.message : result.error,
    });
    // Generous scheduling tolerance still distinguishes 200ms from 1200ms.
    expect.soft(elapsedMs).toBeLessThan(600);
    expect(result.error).toBeInstanceOf(APITimeoutError);
  });

  it('tears down the transport after a rejected HTTP upgrade', async () => {
    const host = await endpoint();
    host.server.on('upgrade', (_req, socket) => {
      socket.resume();
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n',
      );
    });
    const client = host.client();
    await expect(client.currentConnection(5_000)).rejects.toThrow('Unauthorized');
    await client.close();
    await expect.poll(() => host.sockets.size, { timeout: 300 }).toBe(0);
  });
});
