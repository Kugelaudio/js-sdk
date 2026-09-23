/**
 * Operation scope and request-id correlation, driven through the real client
 * (contract "Operation scope" and "Request-ID correlation" in
 * `services/ingress/docs/sdk-diagnostics-contract.md`):
 *
 * - HTTP and one-shot calls: one operation per call.
 * - Streaming session / multi-context: the connection is its own operation,
 *   then one operation per turn (per context), each with its own id, chunk
 *   count and retry count; cancelling one never touches another.
 * - A refused WS upgrade's `x-request-id` reaches the typed error and the event.
 *
 * WebSockets are mocked and every test injects a recording sender.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KugelAudio } from './client';
import { AuthenticationError, classifyWsHandshakeError } from './errors';

interface MockWs {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  listeners: Map<string, (...args: unknown[]) => void>;
}

let sockets: MockWs[] = [];

vi.mock('./websocket', () => ({
  getWebSocket: () =>
    class MockWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: ((event: { code: number; reason?: string }) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      listeners = new Map<string, (...args: unknown[]) => void>();

      constructor() {
        sockets.push(this as unknown as MockWs);
      }

      /** The `ws` package's EventEmitter surface, as far as the SDK uses it. */
      on(event: string, listener: (...args: unknown[]) => void): void {
        this.listeners.set(event, listener);
      }

      /** Mirrors `ws`: a CONNECTING socket aborts with one error and one close. */
      terminate(): void {
        this.onerror?.({
          error: new Error('WebSocket was closed before the connection was established'),
        });
        this.onclose?.({ code: 1006 });
      }
    },
}));

interface Recorded {
  records: Record<string, string>[];
}

/** A client whose reporter records every record it would have sent. */
function recordingClient(): { client: KugelAudio; sent: Recorded } {
  const sent: Recorded = { records: [] };
  const client = new KugelAudio({ apiKey: 'k' });
  client.diagnostics.setSender((_url, _headers, payload) => {
    for (const record of JSON.parse(payload).resourceLogs[0].scopeLogs[0].logRecords) {
      const attrs: Record<string, string> = {};
      for (const kv of record.attributes) attrs[kv.key] = kv.value.stringValue ?? kv.value.intValue;
      sent.records.push(attrs);
    }
  });
  return { client, sent };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function open(ws: MockWs): void {
  ws.readyState = 1;
  ws.onopen?.();
}

function frame(ws: MockWs, data: Record<string, unknown>): void {
  ws.onmessage?.({ data: JSON.stringify(data) });
}

const AUDIO = 'AAAAAAAA'; // 6 decoded bytes

beforeEach(() => {
  sockets = [];
});

describe('HTTP: one operation per call', () => {
  it('gives two failing calls two operation ids', async () => {
    const { client, sent } = recordingClient();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(client.models.list()).rejects.toThrow();
    await expect(client.models.list()).rejects.toThrow();
    await client.diagnostics.flush();
    vi.unstubAllGlobals();

    expect(sent.records).toHaveLength(2);
    expect(sent.records[0]['kugel.operation_id']).not.toBe(sent.records[1]['kugel.operation_id']);
    expect(sent.records.every((r) => r['kugel.event'] === 'request_failed')).toBe(true);
  });

  it('labels a fetch that never got a response connection_failed', async () => {
    const { client, sent } = recordingClient();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(client.voices.list()).rejects.toThrow();
    await client.diagnostics.flush();
    vi.unstubAllGlobals();

    expect(sent.records[0]['kugel.event']).toBe('connection_failed');
    expect(sent.records[0]['kugel.operation']).toBe('voices');
    expect(sent.records[0]['kugel.error_type']).toBe('ConnectionError');
  });
});

describe('streaming session: connection op, then one op per turn', () => {
  async function connected(client: KugelAudio) {
    const session = client.tts.streamingSession({ voiceId: 1 }, {});
    const pending = session.connect();
    await settle();
    open(sockets[0]);
    await pending;
    return session;
  }

  it('scopes chunks and ids to the failing turn; the successful turn and connect only count', async () => {
    const { client, sent } = recordingClient();
    const session = await connected(client);
    const ws = sockets[0];

    session.send('Erster Satz.', true);
    frame(ws, { audio: AUDIO });
    frame(ws, { audio: AUDIO });
    frame(ws, { final: true });
    frame(ws, { session_closed: true });

    session.send('Zweiter Satz.', true);
    frame(ws, { audio: AUDIO });
    frame(ws, { error: 'model down', error_code: 'MODEL_UNAVAILABLE', request_id: 'req-turn-2' });
    await client.diagnostics.flush();

    expect(sent.records).toHaveLength(1);
    const failure = sent.records[0];
    expect(failure['kugel.event']).toBe('request_failed');
    expect(failure['kugel.operation']).toBe('stream_session');
    expect(failure['kugel.audio_chunks']).toBe('1');
    expect(failure['kugel.audio_bytes']).toBe('6');
    expect(failure['kugel.retry_count']).toBe('0');
    expect(failure['kugel.failure_stage']).toBe('receiving_audio');
    expect(failure['kugel.server_request_id']).toBe('req-turn-2');
    // Connect + turn 1 succeeded; turn 2 failed.
    expect(client.diagnostics.counters).toMatchObject({ successes: 2, failures: 1, cancellations: 0 });
  });

  it('counts a cancelled turn as a cancellation and leaves the next turn untouched', async () => {
    const { client, sent } = recordingClient();
    const session = await connected(client);
    const ws = sockets[0];

    session.send('Wird unterbrochen');
    frame(ws, { audio: AUDIO });
    void session.cancelCurrent();
    frame(ws, { interrupted: true });

    session.send('Neuer Turn', true);
    frame(ws, { final: true });
    await client.diagnostics.flush();

    expect(sent.records).toHaveLength(0);
    expect(client.diagnostics.counters).toMatchObject({ successes: 2, failures: 0, cancellations: 1 });
  });

  it('reports a failed connect as its own connection_failed operation', async () => {
    const { client, sent } = recordingClient();
    const session = client.tts.streamingSession({ voiceId: 1 }, {});
    const pending = session.connect();
    await settle();
    sockets[0].onclose?.({ code: 4001 });
    await expect(pending).rejects.toBeInstanceOf(AuthenticationError);
    await client.diagnostics.flush();

    expect(sent.records).toHaveLength(1);
    expect(sent.records[0]['kugel.event']).toBe('connection_failed');
    expect(sent.records[0]['kugel.operation']).toBe('stream_session');
    expect(sent.records[0]['kugel.ws_close_code']).toBe('4001');
  });

  it('counts a recovered rolling-deploy replay in that turn only; the next turn starts at zero', async () => {
    const { client, sent } = recordingClient();
    const session = await connected(client);

    session.send('Vor dem Deploy', true);
    sockets[0].onclose?.({ code: 1012 });
    await new Promise((resolve) => setTimeout(resolve, 1_050)); // retryAfter = 1 s
    open(sockets[1]);
    await settle();
    frame(sockets[1], { audio: AUDIO });
    frame(sockets[1], { final: true });

    session.send('Danach');
    sockets[1].onclose?.({ code: 1006 });
    await client.diagnostics.flush();

    expect(sent.records).toHaveLength(1);
    expect(sent.records[0]['kugel.event']).toBe('stream_interrupted');
    expect(sent.records[0]['kugel.retry_count']).toBe('0');
    expect(sent.records[0]['kugel.ws_close_code']).toBe('1006');
    expect(client.diagnostics.counters).toMatchObject({ successes: 2, failures: 1 });
  });
});

describe('multi-context: one op per context turn', () => {
  it('fails, succeeds and cancels contexts independently', async () => {
    const { client, sent } = recordingClient();
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    const pending = session.connect({});
    await settle();
    open(sockets[0]);
    await pending;
    const ws = sockets[0];

    session.send('a', 'Kontext A', true);
    session.send('b', 'Kontext B', true);
    session.send('c', 'Kontext C');

    frame(ws, { audio: AUDIO, context_id: 'a' });
    frame(ws, { audio: AUDIO, context_id: 'b' });
    frame(ws, { audio: AUDIO, context_id: 'b' });
    frame(ws, { error: 'no voice', error_code: 'MISSING_VOICE_ID', context_id: 'b' });
    frame(ws, { final: true, context_id: 'a' });
    session.closeContext('c', true); // barge-in on C only
    await client.diagnostics.flush();

    expect(sent.records).toHaveLength(1);
    const failure = sent.records[0];
    expect(failure['kugel.event']).toBe('request_failed');
    expect(failure['kugel.operation']).toBe('multi_context');
    expect(failure['kugel.error_code']).toBe('MISSING_VOICE_ID');
    expect(failure['kugel.audio_chunks']).toBe('2');
    // Connect + A succeeded, B failed, C cancelled.
    expect(client.diagnostics.counters).toMatchObject({ successes: 2, failures: 1, cancellations: 1 });
  });

  it('interrupts every context turn in flight when the socket drops, with one op each', async () => {
    const { client, sent } = recordingClient();
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    const pending = session.connect({});
    await settle();
    open(sockets[0]);
    await pending;

    session.send('a', 'Kontext A', true);
    session.send('b', 'Kontext B', true);
    sockets[0].onclose?.({ code: 1006 });
    await client.diagnostics.flush();

    expect(sent.records.map((r) => r['kugel.event'])).toEqual(['stream_interrupted', 'stream_interrupted']);
    expect(sent.records[0]['kugel.operation_id']).not.toBe(sent.records[1]['kugel.operation_id']);
  });
});

describe('WS handshake rejection carries x-request-id', () => {
  it('reads it from the kept rejection headers', () => {
    const err = classifyWsHandshakeError({
      statusCode: 429,
      message: 'Unexpected server response: 429',
      headers: { 'x-request-id': 'req-hs-0' },
    });
    expect(err?.requestId).toBe('req-hs-0');
    expect(err?.statusCode).toBe(429);
  });

  it('puts it on the typed error and on the connection_failed event', async () => {
    const { client, sent } = recordingClient();
    const pending = client.tts.stream({ text: 'hi', language: 'en' }, {});
    await settle();
    const onResponse = sockets[0].listeners.get('unexpected-response');
    expect(onResponse).toBeDefined();
    onResponse!({}, { statusCode: 401, headers: { 'x-request-id': 'req-hs-1' } });

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).requestId).toBe('req-hs-1');

    await client.diagnostics.flush();
    expect(sent.records).toHaveLength(1);
    expect(sent.records[0]['kugel.event']).toBe('connection_failed');
    expect(sent.records[0]['kugel.failure_stage']).toBe('handshake');
    expect(sent.records[0]['kugel.http_status']).toBe('401');
    expect(sent.records[0]['kugel.server_request_id']).toBe('req-hs-1');
  });
});
