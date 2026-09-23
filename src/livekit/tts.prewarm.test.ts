/**
 * Connection-acquisition tests for the LiveKit plugin: `prewarm()`,
 * `currentConnection()` timeout budgeting, and the connection mutex.
 *
 * Regression cover for the customer-reported hang (KUG-1620): `prewarm()` used
 * to take the connection lock and hold it for its full 10s connect, so a
 * synthesis call passing `connOptions.timeoutMs = 2500` waited ~10s for the
 * lock and only then started its own 2.5s connect — ~12.5s against a dead API.
 *
 * Also covers the `speed` option's validation band.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initializeLogger } from '@livekit/agents';

import { MockMultiServer } from './mockServer';
import { TTS } from './tts';

let server: MockMultiServer;
const openTTS: TTS[] = [];

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(async () => {
  for (const t of openTTS.splice(0)) await t.close();
  await server?.close();
});

/**
 * A TTS pointed at a server that accepts the TCP connection and never answers
 * the WebSocket handshake — a dead API that hangs rather than refusing.
 */
async function setupBlackHole(): Promise<TTS> {
  server = new MockMultiServer();
  server.blackHole = true;
  const baseURL = await server.listen();
  const instance = new TTS({ apiKey: 'test-key', baseURL, language: 'en' });
  openTTS.push(instance);
  return instance;
}

async function setupLive(): Promise<TTS> {
  server = new MockMultiServer();
  const baseURL = await server.listen();
  const instance = new TTS({ apiKey: 'test-key', baseURL, language: 'en' });
  openTTS.push(instance);
  return instance;
}

describe('currentConnection timeout budgeting', () => {
  it(
    'bounds lock-wait + connect by timeoutMs while a 10s prewarm holds the lock, ' +
      'and leaves the mutex usable afterwards',
    async () => {
      const instance = await setupBlackHole();

      // Hold the connection lock for a full 10s connect against the black hole.
      instance.prewarm(10_000);
      // Let prewarm reach the lock before the contending caller arrives.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const started = Date.now();
      await expect(instance.currentConnection(2_500)).rejects.toThrow();
      const elapsed = Date.now() - started;

      // Buggy behaviour: ~10s waiting for the lock + 2.5s connecting = ~12.5s.
      expect(elapsed).toBeLessThan(5_000);
      expect(elapsed).toBeGreaterThanOrEqual(2_000);

      // The timed-out waiter must not have poisoned the mutex. Unblock the
      // server so the in-flight prewarm connect fails and releases the lock.
      server.blackHole = false;
      server.destroyHeldSockets();

      const conn = await instance.currentConnection(5_000);
      expect(conn.closed).toBe(false);
      expect(server.connectionCount).toBe(1);
    },
    30_000,
  );

  it('prewarm forwards its timeout instead of always using the 10s default', async () => {
    const instance = await setupBlackHole();

    const started = Date.now();
    instance.prewarm(200);

    // The client aborting its handshake tears the parked upgrade socket down.
    await expect
      .poll(() => server.abortedHandshakes.length, { timeout: 3_000, interval: 20 })
      .toBe(1);

    // With the old hard-coded 10s default this would still be waiting.
    expect(Date.now() - started).toBeLessThan(2_000);
    // prewarm swallows the failure: no rejection escapes to the process.
  }, 15_000);

  it('opens exactly one WebSocket for a burst of concurrent callers', async () => {
    const instance = await setupLive();

    const conns = await Promise.all(
      Array.from({ length: 8 }, () => instance.currentConnection(5_000)),
    );

    expect(server.connectionCount).toBe(1);
    expect(new Set(conns).size).toBe(1);
  }, 15_000);
});

describe('speed validation', () => {
  const base = { apiKey: 'test-key', baseURL: 'http://127.0.0.1:1' };

  it('accepts the band boundaries', () => {
    for (const speed of [0.8, 1.0, 1.2]) {
      expect(() => new TTS({ ...base, speed })).not.toThrow();
    }
  });

  it('throws in the constructor when speed is outside [0.8, 1.2]', () => {
    expect(() => new TTS({ ...base, speed: 0.5 })).toThrow(/speed/i);
    expect(() => new TTS({ ...base, speed: 1.5 })).toThrow(/speed/i);
  });

  it('throws in updateOptions when speed is outside [0.8, 1.2]', () => {
    const instance = new TTS(base);
    expect(() => instance.updateOptions({ speed: 0.79 })).toThrow(/speed/i);
    expect(() => instance.updateOptions({ speed: 1.21 })).toThrow(/speed/i);
    expect(() => instance.updateOptions({ speed: 1.1 })).not.toThrow();
  });
});

describe('temperature validation', () => {
  const base = { apiKey: 'test-key', baseURL: 'http://127.0.0.1:1' };

  it('accepts the range boundaries', () => {
    for (const temperature of [0, 0.5, 1]) {
      expect(() => new TTS({ ...base, temperature })).not.toThrow();
    }
  });

  it('throws in the constructor when temperature is outside [0, 1]', () => {
    expect(() => new TTS({ ...base, temperature: -0.1 })).toThrow(/temperature/i);
    expect(() => new TTS({ ...base, temperature: 1.5 })).toThrow(/temperature/i);
    expect(() => new TTS({ ...base, temperature: Number.NaN })).toThrow(/temperature/i);
  });

  it('throws in updateOptions when temperature is outside [0, 1]', () => {
    const instance = new TTS(base);
    expect(() => instance.updateOptions({ temperature: -0.01 })).toThrow(/temperature/i);
    expect(() => instance.updateOptions({ temperature: 1.01 })).toThrow(/temperature/i);
    expect(() => instance.updateOptions({ temperature: 0.4 })).not.toThrow();
  });
});
