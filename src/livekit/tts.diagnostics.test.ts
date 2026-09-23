/**
 * LiveKit plugin diagnostics against the mock `/ws/tts/multi` server
 * (contract `services/ingress/docs/sdk-diagnostics-contract.md`):
 *
 * - a dropped connection fails the turn in flight (it used to count as a
 *   success on close),
 * - an error frame is `request_failed` with the frame's own request id,
 * - `TTS.close()` emits `sdk_stats`, and closing during a connect is a
 *   cancellation,
 * - a refused upgrade's `x-request-id` reaches the error and the event.
 *
 * - the `telemetry` option follows the core client's enablement order.
 *
 * Telemetry is switched on through `KUGELAUDIO_TELEMETRY` (the mock is a
 * custom endpoint, so it defaults off) and a recording sender is injected.
 */

import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger, type APIStatusError } from '@livekit/agents';

import { MockMultiServer } from './mockServer';
import { SynthesizeStream, TTS } from './tts';

let server: MockMultiServer | null = null;
const openTTS: TTS[] = [];

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

beforeEach(() => {
  vi.stubEnv('KUGELAUDIO_TELEMETRY', '1');
});

afterEach(async () => {
  for (const t of openTTS.splice(0)) await t.close();
  await server?.close();
  server = null;
  vi.unstubAllEnvs();
});

/** A TTS whose reporter records every record it would have sent. */
function recordingTTS(baseURL: string): { instance: TTS; records: Record<string, string>[] } {
  const records: Record<string, string>[] = [];
  const instance = new TTS({ apiKey: 'test-key', baseURL, language: 'en' });
  instance.diagnostics.setSender((_url, _headers, payload) => {
    for (const record of JSON.parse(payload).resourceLogs[0].scopeLogs[0].logRecords) {
      const attrs: Record<string, string> = { body: record.body.stringValue };
      for (const kv of record.attributes) attrs[kv.key] = kv.value.stringValue ?? kv.value.intValue;
      records.push(attrs);
    }
  });
  openTTS.push(instance);
  return { instance, records };
}

async function drain(stream: SynthesizeStream, onFirst?: () => void): Promise<void> {
  let first = true;
  for await (const event of stream) {
    if (event === SynthesizeStream.END_OF_STREAM) break;
    if (first) onFirst?.();
    first = false;
  }
}

describe('LiveKit telemetry option (contract "Enablement" step 2)', () => {
  const HOSTED = 'https://api.kugelaudio.com';

  it('option false disables diagnostics on a hosted URL', () => {
    vi.stubEnv('KUGELAUDIO_TELEMETRY', '');
    expect(new TTS({ apiKey: 'k', baseURL: HOSTED }).diagnostics.enabled).toBe(true);
    expect(new TTS({ apiKey: 'k', baseURL: HOSTED, telemetry: false }).diagnostics.enabled).toBe(false);
  });

  it('option true enables diagnostics on a custom URL', () => {
    vi.stubEnv('KUGELAUDIO_TELEMETRY', '');
    const custom = 'https://tts.acme.corp';
    expect(new TTS({ apiKey: 'k', baseURL: custom }).diagnostics.enabled).toBe(false);
    expect(new TTS({ apiKey: 'k', baseURL: custom, telemetry: true }).diagnostics.enabled).toBe(true);
  });

  it('env KUGELAUDIO_TELEMETRY beats the option in both directions', () => {
    vi.stubEnv('KUGELAUDIO_TELEMETRY', '1');
    expect(new TTS({ apiKey: 'k', baseURL: HOSTED, telemetry: false }).diagnostics.enabled).toBe(true);
    vi.stubEnv('KUGELAUDIO_TELEMETRY', 'off');
    expect(new TTS({ apiKey: 'k', baseURL: HOSTED, telemetry: true }).diagnostics.enabled).toBe(false);
  });
});

describe('LiveKit plugin diagnostics', () => {
  it('fails the turn in flight when the connection drops, instead of counting a success', async () => {
    server = new MockMultiServer();
    const { instance, records } = recordingTTS(await server.listen());
    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));

    const stream = instance.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 10, timeoutMs: 5000 },
    });
    stream.pushText('Hallo');
    stream.flush();
    // First audio is out: the server vanishes mid-turn.
    await drain(stream, () => {
      for (const client of server!.wss.clients) client.terminate();
    });
    stream.close();
    await instance.diagnostics.flush();

    expect(errors).toHaveLength(1);
    const failures = records.filter((r) => r.body !== 'sdk_stats');
    expect(failures).toHaveLength(1);
    expect(failures[0]!['kugel.event']).toBe('stream_interrupted');
    expect(failures[0]!['kugel.integration']).toBe('livekit');
    expect(failures[0]!['kugel.operation']).toBe('multi_context');
    expect(Number(failures[0]!['kugel.audio_chunks'])).toBeGreaterThan(0);
    expect(failures[0]!['kugel.ws_close_code']).toBe('1006');
    // Only the connection itself succeeded.
    expect(instance.diagnostics.counters).toMatchObject({ successes: 1, failures: 1 });
  }, 10_000);

  it('reports an error frame as request_failed with the frame request id, not the context id', async () => {
    server = new MockMultiServer();
    server.errorFrame = {
      error: 'model exploded',
      error_code: 'INTERNAL_ERROR',
      code: 500,
      request_id: 'req-lk-frame',
    };
    const { instance, records } = recordingTTS(await server.listen());
    instance.on('error', () => {});

    const stream = instance.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 10, timeoutMs: 5000 },
    });
    stream.pushText('boom');
    stream.flush();
    await drain(stream);
    stream.close();
    await instance.diagnostics.flush();

    expect(records).toHaveLength(1);
    expect(records[0]!['kugel.event']).toBe('request_failed');
    expect(records[0]!['kugel.error_code']).toBe('INTERNAL_ERROR');
    expect(records[0]!['kugel.server_request_id']).toBe('req-lk-frame');
    expect(records[0]!['kugel.error_type']).toBe('APIStatusError');
  }, 10_000);

  it('emits sdk_stats from TTS.close()', async () => {
    server = new MockMultiServer();
    const { instance, records } = recordingTTS(await server.listen());

    for await (const _ of instance.synthesize('Hallo Welt')) {
      // drain
    }
    await instance.close();

    const stats = records.filter((r) => r.body === 'sdk_stats');
    expect(stats).toHaveLength(1);
    // The connection and the synthesis.
    expect(stats[0]!['kugel.success_count']).toBe('2');
    expect(stats[0]!['kugel.failure_count']).toBe('0');
    expect(stats[0]!['kugel.integration']).toBe('livekit');
  }, 10_000);

  it('counts TTS.close() during a pending connect as a cancellation, not a failure', async () => {
    server = new MockMultiServer();
    server.blackHole = true; // the handshake is never answered
    const { instance, records } = recordingTTS(await server.listen());

    instance.prewarm(5_000);
    for (let i = 0; i < 100 && server.heldSockets.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(server.heldSockets).toHaveLength(1);
    await instance.close();

    expect(instance.diagnostics.counters).toMatchObject({ failures: 0, cancellations: 1 });
    // No failure event: only the sdk_stats close() emits.
    expect(records.map((r) => r.body)).toEqual(['sdk_stats']);
    expect(records[0]!['kugel.cancelled_count']).toBe('1');
    expect(records[0]!['kugel.failure_count']).toBe('0');
  }, 10_000);

  it('carries a refused upgrade x-request-id onto the error and the event', async () => {
    const refusing: Server = createServer();
    refusing.on('upgrade', (_req, socket) => {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\n' +
          'x-request-id: req-lk-hs\r\n' +
          'Content-Length: 0\r\n' +
          'Connection: close\r\n\r\n',
      );
    });
    refusing.listen(0, '127.0.0.1');
    await once(refusing, 'listening');
    const { port } = refusing.address() as AddressInfo;
    try {
      const { instance, records } = recordingTTS(`http://127.0.0.1:${port}`);
      const errors: Error[] = [];
      instance.on('error', (event) => errors.push(event.error));

      const stream = instance.synthesize('Hallo', { maxRetry: 0, retryIntervalMs: 10, timeoutMs: 5000 });
      for await (const _ of stream) {
        // drain
      }
      await instance.diagnostics.flush();

      expect(errors).toHaveLength(1);
      expect((errors[0] as APIStatusError).requestId).toBe('req-lk-hs');
      expect((errors[0] as APIStatusError).statusCode).toBe(401);
      expect(records).toHaveLength(1);
      expect(records[0]!['kugel.event']).toBe('connection_failed');
      expect(records[0]!['kugel.failure_stage']).toBe('handshake');
      expect(records[0]!['kugel.server_request_id']).toBe('req-lk-hs');
    } finally {
      refusing.close();
    }
  }, 10_000);
});
