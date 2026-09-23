/**
 * Client-error diagnostics against the contract in
 * `services/ingress/docs/sdk-diagnostics-contract.md`: the enablement matrix,
 * delivery through our own authenticated API (endpoint derivation, auth
 * headers, non-2xx dropped silently and the three-`404` self-disable), the
 * OTLP envelope, the attribute allowlist, the queue bound, sender-failure
 * isolation, real error paths, cancellation accounting, and request-id
 * correlation. Batch caps, retries and `close()` bounds live in
 * `diagnostics.delivery.test.ts`; operation scope in `diagnostics.scope.test.ts`.
 *
 * Every test injects a recording sender: nothing here touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KugelAudio } from './client';
import {
  TELEMETRY_PATH,
  Diagnostics,
  endpointKindFor,
  resolveTelemetryEnabled,
} from './diagnostics';
import type { DiagnosticsEnv, DiagnosticsSender } from './diagnostics';
import { encodeAttributes, encodeOtlpPayload } from './diagnosticsWire';
import { AuthenticationError, ConnectionError, classifyHttpError, classifyWsFrame } from './errors';

// ---------------------------------------------------------------------------
// WebSocket mock — nothing auto-opens; each test drives the lifecycle.
// ---------------------------------------------------------------------------

interface MockWs {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let sockets: MockWs[] = [];

vi.mock('./websocket', () => ({
  getWebSocket: () =>
    class MockWebSocket {
      url: string;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: ((event: { code: number; reason?: string }) => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor(url: string) {
        this.url = url;
        sockets.push(this as unknown as MockWs);
      }
    },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SentBatch {
  url: string;
  headers: Record<string, string>;
  payload: string;
}

/**
 * Recording sender: the injectable seam that keeps tests off the network.
 * Returns nothing, i.e. "no HTTP status observed" — the shape a fake takes
 * when the test does not care about the response.
 */
function recorder(): { sent: SentBatch[]; send: (u: string, h: Record<string, string>, p: string) => void } {
  const sent: SentBatch[] = [];
  return {
    sent,
    send: (url, headers, payload) => {
      sent.push({ url, headers, payload });
    },
  };
}

/** The SDK's existing auth headers, which diagnostics reuses verbatim. */
const AUTH_HEADERS = { 'X-API-Key': 'test-key', Authorization: 'Bearer test-key' };

function activeDiagnostics(
  send: DiagnosticsSender,
  env: DiagnosticsEnv = {},
): Diagnostics {
  return new Diagnostics({
    apiUrl: 'https://api.kugelaudio.com',
    sdkVersion: '9.9.9',
    authHeaders: AUTH_HEADERS,
    sender: send,
    env,
  });
}

/** Every attribute of the first record in a serialized batch. */
function attributesOf(payload: string, recordIndex = 0): Record<string, string> {
  const parsed = JSON.parse(payload);
  const record = parsed.resourceLogs[0].scopeLogs[0].logRecords[recordIndex];
  const out: Record<string, string> = {};
  for (const kv of record.attributes) {
    out[kv.key] = kv.value.stringValue ?? kv.value.intValue;
  }
  return out;
}

function recordsOf(payload: string): { body: { stringValue: string } }[] {
  return JSON.parse(payload).resourceLogs[0].scopeLogs[0].logRecords;
}

/** Wait for the pending microtasks a mocked socket callback schedules. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  sockets = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 1. Enablement matrix
// ---------------------------------------------------------------------------

describe('enablement (contract B3)', () => {
  const HOSTED = 'https://api.kugelaudio.com';
  const CUSTOM = 'https://tts.internal.acme.corp';

  it('classifies the endpoint by host suffix', () => {
    expect(endpointKindFor(HOSTED)).toBe('hosted');
    expect(endpointKindFor('https://api.eu.kugelaudio.com')).toBe('hosted');
    expect(endpointKindFor(CUSTOM)).toBe('custom');
    expect(endpointKindFor('not a url')).toBe('custom');
  });

  it('defaults on for a hosted endpoint and off for a custom one', () => {
    expect(resolveTelemetryEnabled(HOSTED, undefined, {})).toBe(true);
    expect(resolveTelemetryEnabled(CUSTOM, undefined, {})).toBe(false);
  });

  it('lets the explicit option win over the default, in both directions', () => {
    expect(resolveTelemetryEnabled(HOSTED, false, {})).toBe(false);
    expect(resolveTelemetryEnabled(CUSTOM, true, {})).toBe(true);
  });

  it('lets the environment win over the explicit option, in both directions', () => {
    expect(
      resolveTelemetryEnabled(HOSTED, true, { KUGELAUDIO_TELEMETRY: 'off' }),
    ).toBe(false);
    expect(
      resolveTelemetryEnabled(CUSTOM, false, { KUGELAUDIO_TELEMETRY: '1' }),
    ).toBe(true);
  });

  it('accepts every documented truthy and falsy spelling', () => {
    for (const raw of ['0', 'false', 'off', 'no', 'FALSE', ' No ']) {
      expect(resolveTelemetryEnabled(HOSTED, true, { KUGELAUDIO_TELEMETRY: raw })).toBe(false);
    }
    for (const raw of ['1', 'true', 'on', 'yes', 'TRUE', ' Yes ']) {
      expect(resolveTelemetryEnabled(CUSTOM, false, { KUGELAUDIO_TELEMETRY: raw })).toBe(true);
    }
  });

  it('ignores an unrecognised environment value and falls through', () => {
    expect(resolveTelemetryEnabled(HOSTED, false, { KUGELAUDIO_TELEMETRY: 'maybe' })).toBe(false);
    expect(resolveTelemetryEnabled(HOSTED, undefined, { KUGELAUDIO_TELEMETRY: '' })).toBe(true);
  });

  it('is reachable through the client option without breaking the signature', () => {
    const off = new KugelAudio({ apiKey: 'k', telemetry: false });
    expect(off.diagnostics.enabled).toBe(false);
    const on = new KugelAudio({ apiKey: 'k' });
    expect(on.diagnostics.enabled).toBe(true);
    expect(on.diagnostics.endpointKind).toBe('hosted');
    const onprem = new KugelAudio({ apiKey: 'k', apiUrl: 'https://tts.acme.corp' });
    expect(onprem.diagnostics.enabled).toBe(false);
    expect(onprem.diagnostics.endpointKind).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// 2. Delivery through our own authenticated API (contract C1)
// ---------------------------------------------------------------------------

describe('delivery through the SDK API (contract C1)', () => {
  it('derives the endpoint from the effective API URL', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    diag.report('request_failed', { 'kugel.operation': 'models' });
    await diag.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`https://api.kugelaudio.com${TELEMETRY_PATH}`);
    expect(sent[0].headers['Content-Type']).toBe('application/json');
    // No public ingestion credential exists any more.
    expect(sent[0].headers['x-oneuptime-token']).toBeUndefined();
  });

  it('derives the endpoint from a custom (on-premise) API URL too', async () => {
    const { sent, send } = recorder();
    const diag = new Diagnostics({
      apiUrl: 'https://tts.acme.corp/',
      sdkVersion: '9.9.9',
      authHeaders: AUTH_HEADERS,
      sender: send,
      telemetry: true,
      env: {},
    });
    diag.report('request_failed');
    await diag.flush();
    expect(sent[0].url).toBe(`https://tts.acme.corp${TELEMETRY_PATH}`);
  });

  it("sends the SDK's existing auth headers on the diagnostics POST", async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    diag.report('request_failed');
    await diag.flush();

    expect(sent[0].headers['X-API-Key']).toBe('test-key');
    expect(sent[0].headers['Authorization']).toBe('Bearer test-key');
  });

  it('carries the client auth headers through from a real client', async () => {
    const { sent, send } = recorder();
    const client = new KugelAudio({ apiKey: 'sk_live_supersecret' });
    client.diagnostics.setSender(send);

    expect(client.diagnostics.endpoint).toBe(
      `https://api.kugelaudio.com${TELEMETRY_PATH}`,
    );

    client.diagnostics.report('request_failed');
    await client.diagnostics.flush();

    expect(sent[0].headers['X-API-Key']).toBe('sk_live_supersecret');
    expect(sent[0].headers['Authorization']).toBe('Bearer sk_live_supersecret');
    // …and the key still never reaches the payload.
    expect(sent[0].payload).not.toContain('sk_live_supersecret');
  });

  it('swallows a non-2xx response and keeps reporting', async () => {
    const statuses: number[] = [];
    const diag = activeDiagnostics((_u, _h, _p) => {
      statuses.push(500);
      return 500;
    });

    diag.report('request_failed');
    await expect(diag.flush()).resolves.toBeUndefined();
    diag.report('request_failed');
    await expect(diag.flush()).resolves.toBeUndefined();

    // Dropped in silence, and a server error never retires the reporter.
    expect(statuses).toEqual([500, 500]);
    expect(diag.active).toBe(true);
  });

  it('disables itself after three consecutive 404 responses', async () => {
    let calls = 0;
    const diag = activeDiagnostics(() => {
      calls += 1;
      return 404;
    });

    for (let i = 0; i < 3; i++) {
      diag.report('request_failed');
      await diag.flush();
    }
    expect(calls).toBe(3);
    expect(diag.active).toBe(false);

    // An ingress without the route is not pestered again.
    for (let i = 0; i < 20; i++) diag.report('request_failed');
    await diag.flush();
    await diag.close();
    expect(calls).toBe(3);
    expect(diag.counters.queued).toBe(0);
  });

  it('counts only CONSECUTIVE 404s: any other status resets the streak', async () => {
    const statuses = [404, 404, 202, 404, 404];
    let calls = 0;
    const diag = activeDiagnostics(() => statuses[calls++] ?? 404);

    for (let i = 0; i < 5; i++) {
      diag.report('request_failed');
      await diag.flush();
    }
    expect(calls).toBe(5);
    expect(diag.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. OTLP envelope
// ---------------------------------------------------------------------------

describe('OTLP encoding (contract B1)', () => {
  it('emits the exact resource and scope shape', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    diag.report('connection_failed', { 'kugel.operation': 'stream' });
    await diag.flush();

    const parsed = JSON.parse(sent[0].payload);
    expect(Object.keys(parsed)).toEqual(['resourceLogs']);
    const resourceLog = parsed.resourceLogs[0];
    expect(resourceLog.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'kugelaudio-sdk' } },
      { key: 'service.version', value: { stringValue: '9.9.9' } },
      { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
    ]);
    const scopeLog = resourceLog.scopeLogs[0];
    expect(scopeLog.scope).toEqual({ name: 'kugelaudio.diagnostics', version: '1' });

    const record = scopeLog.logRecords[0];
    expect(record.severityNumber).toBe(17);
    expect(record.severityText).toBe('ERROR');
    expect(record.body).toEqual({ stringValue: 'connection_failed' });
    expect(record.timeUnixNano).toMatch(/^\d+$/);
    // Nanoseconds, not milliseconds.
    expect(record.timeUnixNano.length).toBeGreaterThanOrEqual(19);
  });

  it('encodes ints as OTLP string-typed int64 and always carries the required keys', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    diag.report('request_failed', {
      'kugel.operation_id': 'a'.repeat(32),
      'kugel.http_status': 401,
      'kugel.elapsed_ms': 12,
    });
    await diag.flush();

    const parsed = JSON.parse(sent[0].payload);
    const attrs: Record<string, unknown> = {};
    for (const kv of parsed.resourceLogs[0].scopeLogs[0].logRecords[0].attributes) {
      attrs[kv.key] = kv.value;
    }
    expect(attrs['kugel.http_status']).toEqual({ intValue: '401' });
    expect(attrs['kugel.elapsed_ms']).toEqual({ intValue: '12' });
    expect(attrs['kugel.event']).toEqual({ stringValue: 'request_failed' });
    expect(attrs['kugel.sdk.name']).toEqual({ stringValue: 'js' });
    expect(attrs['kugel.sdk.version']).toEqual({ stringValue: '9.9.9' });
    expect((attrs['kugel.event_id'] as { stringValue: string }).stringValue).toMatch(
      /^[0-9a-f]{32}$/,
    );
    expect((attrs['kugel.operation_id'] as { stringValue: string }).stringValue).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });

  it('reports the runtime as node/<major.minor.patch>', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    diag.report('request_failed');
    await diag.flush();
    expect(attributesOf(sent[0].payload)['kugel.runtime']).toMatch(/^node\/\d+\.\d+\.\d+$/);
  });

  it('encodes an empty batch envelope without throwing', () => {
    expect(JSON.parse(encodeOtlpPayload([], '1.2.3'))).toEqual({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'kugelaudio-sdk' } },
              { key: 'service.version', value: { stringValue: '1.2.3' } },
              { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
            ],
          },
          scopeLogs: [
            { scope: { name: 'kugelaudio.diagnostics', version: '1' }, logRecords: [] },
          ],
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Attribute allowlist
// ---------------------------------------------------------------------------

describe('attribute allowlist (contract B2)', () => {
  it('drops any key outside the table', () => {
    const encoded = encodeAttributes({
      'kugel.event': 'request_failed',
      'kugel.text': 'the secret sentence we synthesized',
      'http.url': 'https://api.kugelaudio.com/v1/models',
      'user.id': '42',
      'kugel.http_status': 500,
    });
    expect(encoded.map((kv: { key: string }) => kv.key)).toEqual(['kugel.event', 'kugel.http_status']);
  });

  it('drops undefined values rather than emitting nulls', () => {
    expect(encodeAttributes({ 'kugel.error_code': undefined, 'kugel.ws_close_code': undefined }))
      .toEqual([]);
  });

  it('drops a non-numeric value for an int-typed key', () => {
    expect(encodeAttributes({ 'kugel.http_status': 'four-oh-one' })).toEqual([]);
  });

  it('never lets input text or an API key reach the serialized payload', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    diag.report('request_failed', {
      'kugel.operation': 'generate',
      // A caller (or a future careless edit) trying to attach payloads.
      'kugel.text': 'Guten Tag, mein IBAN lautet DE02120300000000202051.',
      'kugel.api_key': 'sk_live_supersecret',
      'error.message': 'failed for sk_live_supersecret',
    } as Record<string, string>);
    await diag.flush();

    const payload = sent[0].payload;
    expect(payload).not.toContain('IBAN');
    expect(payload).not.toContain('sk_live_supersecret');
    expect(payload).not.toContain('Guten Tag');
  });
});

// ---------------------------------------------------------------------------
// 5. Queue bound
// ---------------------------------------------------------------------------

describe('queue bound (contract B4)', () => {
  /**
   * A sender that accepts the first batch and then never settles, so exactly
   * one delivery stays on the wire and everything after it has to survive (or
   * not) in the queue. This is the only condition under which the bound does
   * any work, so it is the condition the test has to create.
   */
  function stalledDiagnostics(): { diag: Diagnostics; batches: SentBatch[] } {
    const batches: SentBatch[] = [];
    const diag = activeDiagnostics((url, headers, payload) => {
      batches.push({ url, headers, payload });
      return new Promise<void>(() => {});
    });
    return { diag, batches };
  }

  it('keeps at most 64 events while a delivery is stalled', () => {
    const { diag, batches } = stalledDiagnostics();
    for (let i = 0; i < 100; i++) {
      diag.report('request_failed', { 'kugel.retry_count': i });
    }

    // First 8 went out; the other 92 could not, and 64 is the ceiling.
    const delivered = batches.flatMap((b) => recordsOf(b.payload));
    expect(delivered).toHaveLength(8);
    expect(diag.counters.queued).toBe(64);
    expect(diag.counters.dropped).toBe(92 - 64);
  });

  it('drops the OLDEST event when the queue overflows', async () => {
    const batches: SentBatch[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const diag = activeDiagnostics(async (url, headers, payload) => {
      batches.push({ url, headers, payload });
      // The first POST stalls until released; everything after it is queued.
      if (batches.length === 1) await gate;
    });
    for (let i = 0; i < 100; i++) {
      diag.report('request_failed', { 'kugel.retry_count': i });
    }
    release();
    await diag.flush();

    const survivors = batches.slice(1).flatMap((b) => recordsOf(b.payload));
    expect(survivors).toHaveLength(64);
    // Events 8..99 were queued; the oldest 28 of those were dropped, so the
    // window that survived starts at 36 and ends at 99.
    const retries = batches.slice(1).flatMap((b) =>
      recordsOf(b.payload).map((_, i) => attributesOf(b.payload, i)['kugel.retry_count']),
    );
    expect(retries[0]).toBe('36');
    expect(retries[63]).toBe('99');
  });

  it('flushes as soon as 8 events are queued', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    for (let i = 0; i < 8; i++) diag.report('request_failed');
    expect(sent).toHaveLength(1);
    expect(recordsOf(sent[0].payload)).toHaveLength(8);
    expect(diag.counters.queued).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Sender failures are contained
// ---------------------------------------------------------------------------

describe('failure isolation (contract B4)', () => {
  it('does not raise into the caller when the sender throws synchronously', async () => {
    const diag = activeDiagnostics(() => {
      throw new Error('collector unreachable');
    });
    for (let i = 0; i < 8; i++) diag.report('request_failed');
    await expect(diag.flush()).resolves.toBeUndefined();
    await expect(diag.close()).resolves.toBeUndefined();
  });

  it('does not raise into the caller when the sender rejects', async () => {
    const diag = activeDiagnostics(() => Promise.reject(new Error('502')));
    diag.report('request_failed');
    await expect(diag.flush()).resolves.toBeUndefined();
  });

  it('lets the operation result through even when reporting fails', async () => {
    const diag = activeDiagnostics(() => {
      throw new Error('collector unreachable');
    });
    await expect(
      diag.run('models', 'http', async () => {
        throw new AuthenticationError();
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(diag.counters.failures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Real SDK error paths
// ---------------------------------------------------------------------------

describe('real error paths (contract B5.7)', () => {
  it('reports exactly one request_failed for a mocked HTTP 401', async () => {
    const { sent, send } = recorder();
    const client = new KugelAudio({ apiKey: 'sk_live_supersecret' });
    client.diagnostics.setSender(send);

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'bad key', error_code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'x-request-id': 'req-abc123', 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.models.list()).rejects.toBeInstanceOf(AuthenticationError);
    await client.diagnostics.flush();

    expect(sent).toHaveLength(1);
    const records = recordsOf(sent[0].payload);
    expect(records).toHaveLength(1);

    const attrs = attributesOf(sent[0].payload);
    expect(attrs['kugel.event']).toBe('request_failed');
    expect(attrs['kugel.operation']).toBe('models');
    expect(attrs['kugel.transport']).toBe('http');
    expect(attrs['kugel.failure_stage']).toBe('sending_request');
    expect(attrs['kugel.error_type']).toBe('AuthenticationError');
    expect(attrs['kugel.error_code']).toBe('UNAUTHORIZED');
    expect(attrs['kugel.http_status']).toBe('401');
    expect(attrs['kugel.server_request_id']).toBe('req-abc123');
    expect(attrs['kugel.outcome']).toBe('failed');
    expect(attrs['kugel.endpoint_kind']).toBe('hosted');
    expect(attrs['kugel.integration']).toBe('none');
    // The API key must not leak, anywhere.
    expect(sent[0].payload).not.toContain('sk_live_supersecret');

    vi.unstubAllGlobals();
  });

  it('reports connection_failed at the handshake for a rejected WS upgrade', async () => {
    const { sent, send } = recorder();
    const client = new KugelAudio({ apiKey: 'k' });
    client.diagnostics.setSender(send);

    const pending = client.tts.stream({ text: 'hi', language: 'en' }, {});
    await settle();
    sockets[0].onerror?.({ error: { message: 'Unexpected server response: 401' } });

    await expect(pending).rejects.toBeInstanceOf(AuthenticationError);
    await client.diagnostics.flush();

    const attrs = attributesOf(sent[0].payload);
    expect(attrs['kugel.event']).toBe('connection_failed');
    expect(attrs['kugel.operation']).toBe('stream');
    expect(attrs['kugel.transport']).toBe('websocket');
    expect(attrs['kugel.failure_stage']).toBe('handshake');
    expect(attrs['kugel.error_type']).toBe('AuthenticationError');
    expect(attrs['kugel.http_status']).toBe('401');
  });

  it('reports stream_interrupted for a mid-stream WS close 1006', async () => {
    const { sent, send } = recorder();
    const client = new KugelAudio({ apiKey: 'k' });
    client.diagnostics.setSender(send);

    const session = client.tts.streamingSession({ voiceId: 1 }, {});
    const connected = session.connect();
    await settle();
    sockets[0].readyState = 1;
    sockets[0].onopen?.();
    await connected;
    // A turn is in flight: the drop interrupts it.
    session.send('Hallo Welt');

    // Server vanished: an abnormal close, not one of the typed error codes.
    sockets[0].onclose?.({ code: 1006 });
    await client.diagnostics.flush();

    expect(recordsOf(sent[0].payload)).toHaveLength(1);
    const attrs = attributesOf(sent[0].payload);
    expect(attrs['kugel.event']).toBe('stream_interrupted');
    expect(attrs['kugel.operation']).toBe('stream_session');
    expect(attrs['kugel.transport']).toBe('websocket');
    expect(attrs['kugel.ws_close_code']).toBe('1006');
    expect(attrs['kugel.error_type']).toBe('ConnectionError');
    expect(attrs['kugel.outcome']).toBe('failed');
  });

  it('reports stream_interrupted with the close code when stream() dies on 1006', async () => {
    const { sent, send } = recorder();
    const client = new KugelAudio({ apiKey: 'k' });
    client.diagnostics.setSender(send);

    const pending = client.tts.stream({ text: 'hi', language: 'en' }, {});
    await settle();
    sockets[0].readyState = 1;
    sockets[0].onopen?.();
    await settle();
    sockets[0].onmessage?.({
      data: JSON.stringify({ audio: 'AAAAAAAA', enc: 'pcm_s16le', idx: 0, sr: 24000 }),
    });

    // Server vanished mid-stream: no final frame, and 1006 is not one of the
    // typed error codes. The caller must still see a rejection.
    sockets[0].onclose?.({ code: 1006 });

    await expect(pending).rejects.toBeInstanceOf(ConnectionError);
    await client.diagnostics.flush();

    expect(recordsOf(sent[0].payload)).toHaveLength(1);
    const attrs = attributesOf(sent[0].payload);
    expect(attrs['kugel.event']).toBe('stream_interrupted');
    expect(attrs['kugel.operation']).toBe('stream');
    expect(attrs['kugel.transport']).toBe('websocket');
    expect(attrs['kugel.failure_stage']).toBe('receiving_audio');
    expect(attrs['kugel.ws_close_code']).toBe('1006');
    expect(attrs['kugel.error_type']).toBe('ConnectionError');
    expect(attrs['kugel.audio_chunks']).toBe('1');
    expect(attrs['kugel.outcome']).toBe('failed');
  }, 2000);

  it('reports one event, not one per throw, and counts chunks seen before the failure', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);

    await expect(
      diag.run('stream', 'websocket', async (op) => {
        op.markStage('awaiting_first_audio');
        op.recordChunk(4096);
        op.recordChunk(4096);
        // The SDK internally raises more than once on a bad stream; only the
        // caller-visible failure may be reported.
        op.fail(new ConnectionError('first'));
        throw new ConnectionError('second');
      }),
    ).rejects.toBeInstanceOf(ConnectionError);

    await diag.flush();
    expect(recordsOf(sent[0].payload)).toHaveLength(1);
    const attrs = attributesOf(sent[0].payload);
    expect(attrs['kugel.audio_chunks']).toBe('2');
    expect(attrs['kugel.audio_bytes']).toBe('8192');
    expect(attrs['kugel.failure_stage']).toBe('receiving_audio');
    expect(diag.counters.failures).toBe(1);
  });

  it('reports retry_exhausted once a retry was burned', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    const op = diag.startOperation('stream', 'websocket');
    op.markRetry();
    op.fail(new ConnectionError('gone'));
    await diag.flush();

    const attrs = attributesOf(sent[0].payload);
    expect(attrs['kugel.event']).toBe('retry_exhausted');
    expect(attrs['kugel.retry_count']).toBe('1');
  });

  it('emits no event for a successful operation but counts it in sdk_stats', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    await diag.run('models', 'http', async () => 'ok');
    await diag.flush();
    expect(sent).toHaveLength(0);

    await diag.close();
    const stats = attributesOf(sent[0].payload);
    expect(stats['kugel.event']).toBe('sdk_stats');
    expect(stats['kugel.success_count']).toBe('1');
    expect(stats['kugel.failure_count']).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// 8. Cancellation
// ---------------------------------------------------------------------------

describe('cancellation (contract B2)', () => {
  it('emits no event for an aborted operation and counts a cancellation, not a failure', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);

    await expect(
      diag.run('stream', 'websocket', async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }),
    ).rejects.toThrow();

    await diag.flush();
    // A barge-in-heavy voice agent must not pay one ERROR record per interrupt.
    expect(sent).toHaveLength(0);
    expect(diag.counters.queued).toBe(0);
    expect(diag.counters.failures).toBe(0);
    expect(diag.counters.cancellations).toBe(1);
  });

  it('emits no event when the caller marked the operation cancelled', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    const op = diag.startOperation('stream_session', 'websocket');
    op.markCancelled();
    op.fail(new ConnectionError('socket closed'));
    await diag.flush();

    expect(sent).toHaveLength(0);
    expect(diag.counters.failures).toBe(0);
    expect(diag.counters.cancellations).toBe(1);
  });

  it('keeps a cancelled operation out of the sdk_stats failure count', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);

    await diag.run('models', 'http', async () => 'ok');
    const cancelled = diag.startOperation('stream', 'websocket');
    cancelled.markCancelled();
    cancelled.fail(new ConnectionError('closed'));

    await diag.close();
    const statsBatch = sent[sent.length - 1];
    const records = recordsOf(statsBatch.payload);
    // The cancellation contributed no record of its own.
    expect(records).toHaveLength(1);
    const statsIndex = records.findIndex((r) => r.body.stringValue === 'sdk_stats');
    const stats = attributesOf(statsBatch.payload, statsIndex);
    expect(stats['kugel.success_count']).toBe('1');
    expect(stats['kugel.failure_count']).toBe('0');
    expect(stats['kugel.cancelled_count']).toBe('1');
  });

  it('still reports sdk_stats for a session that only cancelled', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);

    const op = diag.startOperation('stream', 'websocket');
    op.markCancelled();
    op.fail(new ConnectionError('closed'));

    await diag.close();
    const stats = attributesOf(sent[0].payload);
    expect(stats['kugel.event']).toBe('sdk_stats');
    expect(stats['kugel.cancelled_count']).toBe('1');
    expect(stats['kugel.failure_count']).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// 9. Request-id correlation (contract part A3)
// ---------------------------------------------------------------------------

describe('request-id correlation (contract A3)', () => {
  it('reads x-request-id from HTTP response headers onto the typed error', () => {
    const err = classifyHttpError(
      429,
      JSON.stringify({ error: 'slow down', error_code: 'RATE_LIMITED' }),
      new Headers({ 'x-request-id': 'req-http-1' }),
    );
    expect(err.requestId).toBe('req-http-1');
    expect(err.message).toContain('req-http-1');
  });

  it('reads x-request-id from a plain header record too', () => {
    const err = classifyHttpError(500, '', { 'x-request-id': 'req-http-2' });
    expect(err.requestId).toBe('req-http-2');
  });

  it('reads request_id from a WebSocket error frame', () => {
    const err = classifyWsFrame({
      error: 'model unavailable',
      error_code: 'MODEL_UNAVAILABLE',
      request_id: 'req-ws-1',
    });
    expect(err.requestId).toBe('req-ws-1');
    expect(err).toBeInstanceOf(ConnectionError);
  });

  it('leaves requestId undefined when the frame carries none', () => {
    expect(classifyWsFrame({ error: 'boom' }).requestId).toBeUndefined();
  });

  it('puts the server request id on the reported event', async () => {
    const { sent, send } = recorder();
    const diag = activeDiagnostics(send);
    const op = diag.startOperation('stream', 'websocket');
    op.fail(classifyWsFrame({ error: 'nope', error_code: 'UNAUTHORIZED', request_id: 'req-ws-2' }));
    await diag.flush();

    expect(attributesOf(sent[0].payload)['kugel.server_request_id']).toBe('req-ws-2');
  });
});
