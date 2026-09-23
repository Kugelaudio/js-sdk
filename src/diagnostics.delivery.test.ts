/**
 * Diagnostics delivery bounds (contract "Wire format" and "Delivery" in
 * `services/ingress/docs/sdk-diagnostics-contract.md`): at most 8 records per
 * POST, one retry but never for a 413, `Content-Type` set last, `close()`
 * bounded to 1 s, and the event-classification / stage rules the encoder
 * relies on.
 *
 * Nothing here touches the network: senders are injected, and `fetch` is
 * stubbed where the default sender itself is under test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Diagnostics, fetchSender, operationForPath } from './diagnostics';
import type { DiagnosticsSender } from './diagnostics';
import { ConnectionError } from './errors';

interface SentBatch {
  headers: Record<string, string>;
  payload: string;
  signal?: AbortSignal;
}

function records(payload: string): { severityNumber: number; severityText: string; body: { stringValue: string } }[] {
  return JSON.parse(payload).resourceLogs[0].scopeLogs[0].logRecords;
}

function attrs(payload: string, index = 0): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of JSON.parse(payload).resourceLogs[0].scopeLogs[0].logRecords[index].attributes) {
    out[kv.key] = kv.value.stringValue ?? kv.value.intValue;
  }
  return out;
}

function diagnostics(send: DiagnosticsSender, authHeaders: Record<string, string> = {}): Diagnostics {
  return new Diagnostics({
    apiUrl: 'https://api.kugelaudio.com',
    sdkVersion: '9.9.9',
    authHeaders,
    sender: send,
    env: {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('batch cap: at most 8 records per POST', () => {
  it('drains a full 64-record queue as eight POSTs of eight', async () => {
    const batches: SentBatch[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const diag = diagnostics(async (_url, headers, payload) => {
      batches.push({ headers, payload });
      if (batches.length === 1) await gate;
    });

    // The first 8 go out and stall; the queue then fills to its 64 cap.
    for (let i = 0; i < 72; i++) diag.report('request_failed');
    expect(diag.counters.queued).toBe(64);
    release();
    await diag.flush();

    expect(batches).toHaveLength(9);
    expect(batches.map((b) => records(b.payload).length)).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 8]);
    expect(diag.counters.queued).toBe(0);
  });

  it('never sends more than 8 records on flush() of a short backlog either', async () => {
    const sizes: number[] = [];
    const diag = diagnostics((_u, _h, payload) => { sizes.push(records(payload).length); });
    // Below the flush threshold each time, so nothing leaves until flush().
    for (let i = 0; i < 7; i++) diag.report('request_failed');
    await diag.flush();
    expect(sizes).toEqual([7]);
  });
});

describe('default fetch sender', () => {
  it('never retries a 413', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 413 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSender('https://x.kugelaudio.com/v1/sdk-diagnostics', {}, '{}')).resolves.toBe(413);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx exactly once, then drops', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSender('https://x/v1/sdk-diagnostics', {}, '{}')).resolves.toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transport error once and resolves without a status', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSender('https://x/v1/sdk-diagnostics', {}, '{}')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes an AbortSignal and gives up at once when the caller aborts', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const outer = new AbortController();
    const pending = fetchSender('https://x/v1/sdk-diagnostics', {}, '{}', outer.signal);
    outer.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(signals[0]?.aborted).toBe(true);
    // Aborted by close(): no retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('headers', () => {
  it('sets Content-Type last so no auth header can override it', async () => {
    const sent: SentBatch[] = [];
    const diag = diagnostics(
      (_u, headers, payload) => { sent.push({ headers, payload }); },
      { 'X-API-Key': 'k', 'content-type': 'text/plain', 'Content-Type': 'text/html' },
    );
    diag.report('request_failed');
    await diag.flush();

    const entries = Object.entries(sent[0].headers);
    expect(entries[entries.length - 1]).toEqual(['Content-Type', 'application/json']);
    expect(entries.filter(([k]) => k.toLowerCase() === 'content-type')).toHaveLength(1);
    expect(sent[0].headers['X-API-Key']).toBe('k');
  });
});

describe('close()', () => {
  it('resolves within 1 s and aborts a stalled POST instead of waiting on it', async () => {
    const sent: SentBatch[] = [];
    const diag = diagnostics((_u, headers, payload, signal) => {
      sent.push({ headers, payload, signal });
      return new Promise<void>(() => {}); // never settles on its own
    });
    diag.report('request_failed');

    const started = Date.now();
    await diag.close();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(1_500);
    expect(sent).toHaveLength(1);
    expect(sent[0].signal?.aborted).toBe(true);
    expect(diag.counters.queued).toBe(0);
  });

  it('returns as soon as the flush lands when the sender is fast', async () => {
    const diag = diagnostics(() => 202);
    diag.recordSuccess();
    const started = Date.now();
    await diag.close();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('emits sdk_stats at INFO severity; failures stay ERROR', async () => {
    const sent: SentBatch[] = [];
    const diag = diagnostics((_u, headers, payload) => { sent.push({ headers, payload }); });
    diag.startOperation('models', 'http', 'sending_request').fail(new ConnectionError('x'));
    await diag.close();

    const all = sent.flatMap((b) => records(b.payload));
    const failure = all.find((r) => r.body.stringValue === 'request_failed');
    const stats = all.find((r) => r.body.stringValue === 'sdk_stats');
    expect([failure?.severityNumber, failure?.severityText]).toEqual([17, 'ERROR']);
    expect([stats?.severityNumber, stats?.severityText]).toEqual([9, 'INFO']);
  });
});

describe('event classification and stages', () => {
  it('labels an HTTP transport failure before any response connection_failed', async () => {
    const sent: SentBatch[] = [];
    const diag = diagnostics((_u, headers, payload) => { sent.push({ headers, payload }); });
    diag.startOperation('voices', 'http').fail(new ConnectionError('Could not reach'));
    await diag.flush();
    expect(attrs(sent[0].payload)['kugel.event']).toBe('connection_failed');
    expect(attrs(sent[0].payload)['kugel.failure_stage']).toBe('connecting');
  });

  it('labels a WS error frame request_failed and a WS drop stream_interrupted', async () => {
    const sent: SentBatch[] = [];
    const diag = diagnostics((_u, headers, payload) => { sent.push({ headers, payload }); });
    const frame = diag.startOperation('stream', 'websocket', 'awaiting_first_audio');
    const err = Object.assign(new ConnectionError('model down'), { errorCode: 'MODEL_UNAVAILABLE' });
    frame.markServerError(err);
    frame.fail(err);
    diag.startOperation('stream', 'websocket', 'receiving_audio').fail(new ConnectionError('1006'));
    await diag.flush();
    expect(attrs(sent[0].payload, 0)['kugel.event']).toBe('request_failed');
    expect(attrs(sent[0].payload, 0)['kugel.error_code']).toBe('MODEL_UNAVAILABLE');
    expect(attrs(sent[0].payload, 1)['kugel.event']).toBe('stream_interrupted');
  });

  it('moves to receiving_audio only from awaiting_first_audio', () => {
    const diag = diagnostics(() => {});
    const sending = diag.startOperation('stream', 'websocket', 'sending_request');
    sending.recordChunk(10);
    expect(sending.failureStage).toBe('sending_request');
    const finalizing = diag.startOperation('stream', 'websocket', 'finalizing');
    finalizing.recordChunk(10);
    expect(finalizing.failureStage).toBe('finalizing');
    const awaiting = diag.startOperation('stream', 'websocket', 'awaiting_first_audio');
    awaiting.recordChunk(10);
    expect(awaiting.failureStage).toBe('receiving_audio');
    expect(awaiting.audioChunks).toBe(1);
  });

  it('maps unknown HTTP paths to no operation instead of mislabelling them', () => {
    expect(operationForPath('/v1/voices?limit=1')).toBe('voices');
    expect(operationForPath('/v1/models')).toBe('models');
    expect(operationForPath('/v1/dictionaries/3/entries')).toBe('dictionaries');
    expect(operationForPath('/v1/audio/transcriptions')).toBe('transcribe');
    expect(operationForPath('/v1/something-new')).toBeUndefined();
  });

  it('omits kugel.operation for an unmapped path rather than guessing', async () => {
    const sent: SentBatch[] = [];
    const diag = diagnostics((_u, headers, payload) => { sent.push({ headers, payload }); });
    diag.startOperation(operationForPath('/v1/unknown'), 'http', 'sending_request')
      .fail(new ConnectionError('x'));
    await diag.flush();
    expect(attrs(sent[0].payload)['kugel.operation']).toBeUndefined();
    expect(attrs(sent[0].payload)['kugel.event']).toBe('request_failed');
  });

  it('drops string values outside the contract character set', async () => {
    const sent: SentBatch[] = [];
    const diag = diagnostics((_u, headers, payload) => { sent.push({ headers, payload }); });
    diag.report('request_failed', { 'kugel.error_type': 'has spaces and ?' });
    await diag.flush();
    expect(attrs(sent[0].payload)['kugel.error_type']).toBeUndefined();
  });
});

describe('internal telemetry failures are silent', () => {
  /** Watch every channel a failure could leak through while `body` runs. */
  async function expectSilent(body: () => Promise<void>): Promise<void> {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await body();
      await new Promise((resolve) => setTimeout(resolve, 20)); // let stray rejections surface
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
      expect(warningSpy).not.toHaveBeenCalled();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      vi.restoreAllMocks();
    }
  }

  it('a sender that throws or rejects never reaches the caller', async () => {
    await expectSilent(async () => {
      for (const send of [
        () => { throw new Error('sync boom'); },
        () => Promise.reject(new Error('async boom')),
      ] as DiagnosticsSender[]) {
        const diag = diagnostics(send);
        await expect(diag.run('models', 'http', async () => 'ok')).resolves.toBe('ok');
        const own = new ConnectionError('the caller\'s own error');
        await expect(diag.run('models', 'http', async () => { throw own; })).rejects.toBe(own);
        for (let i = 0; i < 9; i++) diag.report('request_failed');
        await diag.flush();
        await diag.close();
      }
    });
  });

  it('an encoder that throws never reaches the caller', async () => {
    await expectSilent(async () => {
      const diag = diagnostics(() => 202);
      const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
        throw new TypeError('encoder boom');
      });
      diag.report('request_failed');
      await expect(diag.flush()).resolves.toBeUndefined();
      await expect(diag.close()).resolves.toBeUndefined();
      stringify.mockRestore();
    });
  });

  it('an attribute that throws while being encoded is dropped with its record, silently', async () => {
    await expectSilent(async () => {
      const sent: SentBatch[] = [];
      const diag = diagnostics((_u, headers, payload) => { sent.push({ headers, payload }); });
      const hostile = { toString(): string { throw new Error('toString boom'); } };
      expect(() => diag.report('request_failed', { 'kugel.error_type': hostile as unknown as string })).not.toThrow();
      diag.report('request_failed');
      await diag.flush();
      expect(sent.flatMap((b) => records(b.payload))).toHaveLength(1);
    });
  });
});

describe('exit flush registration', () => {
  function beforeExitListeners(): number {
    return process.listenerCount('beforeExit');
  }

  it('installs one process listener for many reporters and removes it when none hold records', async () => {
    const baseline = beforeExitListeners();
    const reporters = Array.from({ length: 20 }, () => diagnostics(() => 202));
    for (const diag of reporters) diag.report('request_failed');
    expect(beforeExitListeners()).toBe(baseline + 1);

    // Drained queues leave nothing for an exit flush to do.
    await Promise.all(reporters.map((diag) => diag.flush()));
    expect(beforeExitListeners()).toBe(baseline);

    reporters[0]!.report('request_failed');
    expect(beforeExitListeners()).toBe(baseline + 1);
    await reporters[0]!.close();
    expect(beforeExitListeners()).toBe(baseline);
  });

  it('flushes once on exit and is a no-op after close()', async () => {
    const sent: SentBatch[] = [];
    const diag = diagnostics((_u, headers, payload) => { sent.push({ headers, payload }); });
    diag.report('request_failed');
    process.emit('beforeExit', 0);
    process.emit('beforeExit', 0); // fires again once the flush's work drains
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);

    const closed = diagnostics((_u, headers, payload) => { sent.push({ headers, payload }); });
    closed.report('request_failed');
    await closed.close();
    const afterClose = sent.length;
    process.emit('beforeExit', 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(afterClose);
  });
});
