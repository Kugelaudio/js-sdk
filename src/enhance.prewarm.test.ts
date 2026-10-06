/**
 * Connection reuse and `client.enhance.prewarm()`.
 *
 * Runs the real global `fetch` against a local HTTP/1.1 server that counts
 * accepted TCP connections, so reuse is measured on the socket.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KugelAudio } from './client';

/** A mono PCM16 WAV: 100 ms at 24 kHz. */
function wav(): Uint8Array {
  const frames = 2400;
  const out = new Uint8Array(44 + frames * 2);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * 2, true);
  return out;
}

const OUTPUT = wav();

const WARMUP = 'POST /v1/audio/enhance/warmup';
const ENHANCE = 'POST /v1/audio/enhance';

interface CountingServer {
  url: string;
  connections: () => number;
  requests: string[];
  warmupAuth: (string | undefined)[];
  warmupStatus: number;
  close: () => Promise<void>;
}

async function countingServer(): Promise<CountingServer> {
  let connections = 0;
  const state = { requests: [] as string[], warmupAuth: [] as (string | undefined)[], warmupStatus: 202 };
  const server: Server = createServer((req, res) => {
    const request = `${req.method} ${req.url}`;
    state.requests.push(request);
    req.resume();
    req.on('end', () => {
      if (request === WARMUP) {
        // What the enhance service answers on its warm-up route.
        state.warmupAuth.push(req.headers.authorization);
        const ok = state.warmupStatus === 202;
        const body = ok ? '{"status":"warming"}' : '{"detail":"Invalid API key"}';
        res.writeHead(state.warmupStatus, { 'content-type': 'application/json', 'content-length': body.length });
        res.end(body);
      } else {
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': OUTPUT.length });
        res.end(OUTPUT);
      }
    });
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

let server: CountingServer | null = null;

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = null;
});

describe('client.enhance connection reuse', () => {
  it('sequential generate calls share one connection', async () => {
    server = await countingServer();
    const client = new KugelAudio({ apiKey: 'test-key', apiUrl: server.url });
    for (let i = 0; i < 5; i++) {
      const result = await client.enhance.generate(wav(), { model: 'clarity-1' });
      expect(result.sampleRate).toBe(24000);
      await macrotask();
    }
    expect(server.requests).toEqual(Array(5).fill(ENHANCE));
    expect(server.connections()).toBe(1);
  });

  it('back-to-back generate calls stay on a bounded pool, not one connection each', async () => {
    // fetch returns a socket to its pool one macrotask after the response, so
    // a call issued in the same tick opens a second pooled connection.
    server = await countingServer();
    const client = new KugelAudio({ apiKey: 'test-key', apiUrl: server.url });
    for (let i = 0; i < 6; i++) await client.enhance.generate(wav(), { model: 'clarity-1' });
    expect(server.connections()).toBeLessThanOrEqual(2);
  });

  it('prewarm posts the warm-up with the API key and generate reuses its connection', async () => {
    server = await countingServer();
    const client = new KugelAudio({ apiKey: 'test-key', apiUrl: server.url });
    await client.enhance.prewarm();
    expect(server.connections()).toBe(1);
    await client.enhance.prewarm(); // idempotent: the same connection again
    await client.enhance.generate(wav(), { model: 'clarity-1' });
    expect(server.requests).toEqual([WARMUP, WARMUP, ENHANCE]);
    expect(server.warmupAuth).toEqual(['Bearer test-key', 'Bearer test-key']);
    expect(server.connections()).toBe(1);
  });

  it('prewarm resolves and warns with the status when the warm-up is refused', async () => {
    server = await countingServer();
    server.warmupStatus = 401;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new KugelAudio({ apiKey: 'bad-key', apiUrl: server.url });
    await expect(client.enhance.prewarm()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('401');
  });

  it('prewarm resolves and warns on a network error', async () => {
    const closed = await countingServer();
    const url = closed.url;
    await closed.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new KugelAudio({ apiKey: 'test-key', apiUrl: url });
    await expect(client.enhance.prewarm()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('Could not prewarm');
  });

  it('prewarm resolves when the request times out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hanging = createServer(() => {}); // accepts, never answers
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const { port } = hanging.address() as AddressInfo;
    const client = new KugelAudio({ apiKey: 'test-key', apiUrl: `http://127.0.0.1:${port}`, timeout: 50 });
    await expect(client.enhance.prewarm()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    hanging.closeAllConnections();
    await new Promise<void>((resolve) => hanging.close(() => resolve()));
  });
});
