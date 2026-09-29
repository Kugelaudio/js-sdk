/**
 * Speech enhancement: `client.enhance`, `loadAudio`, `loadAudioStream`.
 *
 * HTTP goes through a stubbed `fetch`; the WebSocket is a scripted fake
 * server that speaks the enhancement stream protocol
 * (config → ready → PCM in / PCM out → end → done → close 1000).
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioStream, LoadedAudio, loadAudio, loadAudioStream } from './audio';
import { KugelAudio } from './client';
import { EnhancedAudio } from './enhance';
import {
  AuthenticationError,
  ConnectionError,
  InsufficientCreditsError,
  KugelAudioError,
  RateLimitError,
  ValidationError,
} from './errors';

// ---------------------------------------------------------------------------
// Fake WebSocket server
// ---------------------------------------------------------------------------

type Server = (ws: FakeWs, data: unknown) => void;

/** A refused upgrade: HTTP status and response headers. */
type Refusal = { statusCode: number; headers: Record<string, string> };

class FakeWs {
  static last: FakeWs | null = null;
  static refusal: Refusal | null = null;
  url: string;
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: unknown[] = [];
  close = vi.fn(() => this.serverClose(1000, ''));
  listeners = new Map<string, (...args: unknown[]) => void>();

  constructor(url: string) {
    this.url = url;
    FakeWs.last = this;
    const refusal = FakeWs.refusal;
    setTimeout(() => {
      if (refusal) {
        this.listeners.get('unexpected-response')?.({}, refusal);
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  /** The `ws` package's EventEmitter surface, as far as the SDK uses it. */
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener);
  }

  /** Mirrors `ws`: a CONNECTING socket aborts with one error and one close. */
  terminate(): void {
    this.readyState = 3;
    this.onerror?.({ error: new Error('WebSocket was closed before the connection was established') });
    this.onclose?.({ code: 1006, reason: '' });
  }

  send(data: unknown): void {
    // Copy views: the SDK may send subarrays of one buffer.
    const copy = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : data;
    this.sent.push(copy);
    queueMicrotask(() => server(this, copy));
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }

  get textMessages(): Record<string, unknown>[] {
    return this.sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m as string));
  }

  get binaryMessages(): Uint8Array[] {
    return this.sent.filter((m) => m instanceof Uint8Array) as Uint8Array[];
  }
}

/** Echo server: every PCM message comes back as the same number of bytes. */
const echoServer: Server = (ws, data) => {
  if (typeof data === 'string') {
    const msg = JSON.parse(data);
    if (msg.type === 'config') ws.emit(JSON.stringify({ type: 'ready', sample_rate_hz: 24000 }));
    if (msg.type === 'end') {
      ws.emit(JSON.stringify({ type: 'done', duration_s: 0.3 }));
      ws.serverClose(1000, '');
    }
    return;
  }
  const bytes = data as Uint8Array;
  ws.emit(new Uint8Array(bytes.length).fill(7).buffer);
};

let server: Server = echoServer;

vi.mock('./websocket', () => ({ getWebSocket: () => FakeWs }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A PCM WAV with the given format; samples are a ramp. */
function wav(opts: { rate?: number; channels?: number; bits?: number; frames?: number } = {}): Uint8Array {
  const { rate = 16000, channels = 1, bits = 16, frames = 1600 } = opts;
  const dataSize = frames * channels * (bits / 8);
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  if (bits === 16) {
    for (let i = 0; i < frames * channels; i++) view.setInt16(44 + i * 2, (i % 200) - 100, true);
  }
  return out;
}

function wavResponse(body: Uint8Array, status = 200): Response {
  return new Response(body as Uint8Array<ArrayBuffer>, { status, headers: { 'content-type': 'audio/wav' } });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const client = () => new KugelAudio({ apiKey: 'test-key' });

beforeEach(() => {
  server = echoServer;
  FakeWs.last = null;
  FakeWs.refusal = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// loadAudio / loadAudioStream
// ---------------------------------------------------------------------------

describe('loadAudio', () => {
  it('keeps the WAV bytes as-is and reads the duration', async () => {
    const bytes = wav({ rate: 16000, frames: 8000 });
    const audio = await loadAudio(bytes);
    expect(audio).toBeInstanceOf(LoadedAudio);
    expect(audio.data).toEqual(bytes);
    expect(audio.filename).toBe('audio.wav');
    expect(audio.duration).toBe(0.5);
  });

  it('reads a file path in Node and keeps its name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ka-enhance-'));
    const path = join(dir, 'meeting.wav');
    await writeFile(path, wav());
    const audio = await loadAudio(path);
    expect(audio.filename).toBe('meeting.wav');
    expect(audio.duration).toBeCloseTo(0.1);
  });

  it('accepts non-WAV bytes without a duration (the server decodes)', async () => {
    const audio = await loadAudio(new Uint8Array([1, 2, 3]));
    expect(audio.duration).toBeUndefined();
  });

  it('rejects empty audio and unreadable paths', async () => {
    await expect(loadAudio(new Uint8Array())).rejects.toBeInstanceOf(ValidationError);
    await expect(loadAudio('/nonexistent/x.wav')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('loadAudioStream', () => {
  it('yields 100 ms chunks by default, sync and async', async () => {
    const stream = await loadAudioStream(wav({ rate: 16000, frames: 4000 }));
    expect(stream).toBeInstanceOf(AudioStream);
    expect(stream.sampleRate).toBe(16000);
    expect(stream.duration).toBe(0.25);
    expect([...stream].map((c) => c.length)).toEqual([3200, 3200, 1600]);
    expect((await collect(stream)).map((c) => c.length)).toEqual([3200, 3200, 1600]);
  });

  it('downmixes stereo to mono', async () => {
    const stream = await loadAudioStream(wav({ channels: 2, frames: 1600 }));
    const chunks = [...stream];
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBe(3200);
    const view = new DataView(chunks[0].buffer, chunks[0].byteOffset);
    expect(view.getInt16(0, true)).toBe(Math.floor((-100 + -99) / 2));
  });

  it('rejects non-16-bit WAVs, non-WAVs and bad chunk lengths', async () => {
    await expect(loadAudioStream(wav({ bits: 24 }))).rejects.toThrow(/24-bit/);
    await expect(loadAudioStream(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(ValidationError);
    await expect(loadAudioStream(wav(), { chunkSeconds: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(loadAudioStream(wav(), { chunkSeconds: 1.5 })).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// EnhancedAudio
// ---------------------------------------------------------------------------

describe('EnhancedAudio', () => {
  it('round-trips WAV and saves to disk', async () => {
    const result = EnhancedAudio.fromWav(wav({ rate: 24000, frames: 2400 }));
    expect(result.sampleRate).toBe(24000);
    expect(result.duration).toBe(0.1);
    expect(EnhancedAudio.fromWav(result.wav).audio).toEqual(result.audio);
    expect(result.toBlob().type).toBe('audio/wav');

    const path = join(await mkdtemp(join(tmpdir(), 'ka-enhance-')), 'clean.wav');
    await result.save(path);
    expect(new Uint8Array(await readFile(path))).toEqual(result.wav);
  });

  it('rejects non-WAV and non-mono-PCM16 responses', () => {
    expect(() => EnhancedAudio.fromWav(new Uint8Array([1, 2, 3]))).toThrow(/not a WAV/);
    expect(() => EnhancedAudio.fromWav(wav({ channels: 2 }))).toThrow(/mono PCM16/);
  });
});

const RPM = 'Rate limit exceeded (10 requests per minute)';
const CONCURRENCY = 'Concurrent generation limit reached (2)';
const NOT_ENABLED = 'Speech enhancement is not enabled for this organization.';
const AT_CAPACITY = 'Speech enhancement is at capacity. Please try again shortly.';

/** A server error frame in the shared `{type, error, error_code, code}` shape. */
function frame(code: number, errorCode: string, error: string, extra: object = {}): object {
  return { type: 'error', error, error_code: errorCode, code, request_id: 'req-ws', ...extra };
}
const RATE_LIMITED_FRAME = frame(429, 'RATE_LIMITED', RPM, { retry_after: 7 });

// ---------------------------------------------------------------------------
// client.enhance.generate
// ---------------------------------------------------------------------------

describe('client.enhance.generate', () => {
  it('posts the audio as multipart and parses the WAV result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(wavResponse(wav({ rate: 24000, frames: 4800 })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client().enhance.generate(await loadAudio(wav()), { model: 'clarity-1' });

    expect(result).toBeInstanceOf(EnhancedAudio);
    expect(result.sampleRate).toBe(24000);
    expect(result.duration).toBe(0.2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.kugelaudio.com/v1/audio/enhance');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-Key']).toBe('test-key');
    const body = init.body as FormData;
    expect(body.get('model')).toBe('clarity-1');
    expect(body.get('task')).toBe('noise_removal');
    expect((body.get('file') as File).name).toBe('audio.wav');
    expect(body.get('speaker')).toBeNull();
  });

  it('switches to target speaker extraction when a speaker is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(wavResponse(wav({ rate: 24000 })));
    vi.stubGlobal('fetch', fetchMock);

    await client().enhance.generate(new Blob([wav() as Uint8Array<ArrayBuffer>]), {
      model: 'clarity-1',
      speaker: wav(),
    });

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get('task')).toBe('target_speaker_extraction');
    expect(body.get('speaker')).toBeInstanceOf(Blob);
    expect(body.get('file')).toBeInstanceOf(Blob);
  });

  it('validates model and audio before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const enhance = client().enhance;
    const audio = await loadAudio(wav());

    await expect(enhance.generate(audio, {} as any)).rejects.toBeInstanceOf(ValidationError);
    await expect(enhance.generate(audio, { model: ' ' })).rejects.toBeInstanceOf(ValidationError);
    await expect(enhance.generate('meeting.wav' as any, { model: 'clarity-1' })).rejects.toThrow(/loadAudio/);
    await expect(
      enhance.generate(audio, { model: 'clarity-1', speaker: 'speaker.wav' as any }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['400', 400, 'VALIDATION_ERROR', 'bad wav', {}, ValidationError, undefined],
    ['401', 401, 'UNAUTHORIZED', 'bad key', {}, AuthenticationError, undefined],
    ['402', 402, 'INSUFFICIENT_CREDITS', 'Insufficient credits', {}, InsufficientCreditsError, undefined],
    ['403 not enabled', 403, 'UNAUTHORIZED', NOT_ENABLED, {}, AuthenticationError, undefined],
    ['429 rpm', 429, 'RATE_LIMITED', RPM, { 'Retry-After': '42' }, RateLimitError, 42],
    ['429 concurrency', 429, 'RATE_LIMITED', CONCURRENCY, {}, RateLimitError, undefined],
    ['503 capacity', 503, 'MODEL_UNAVAILABLE', AT_CAPACITY, { 'Retry-After': '5' }, ConnectionError, 5],
  ] as const)(
    'maps HTTP %s to the same error class as TTS',
    async (_name, status, errorCode, message, headers, errorClass, retryAfter) => {
      const body = { error: message, error_code: errorCode, code: status };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json', 'x-request-id': 'req-http', ...headers },
          }),
        ),
      );
      const err = (await client()
        .enhance.generate(await loadAudio(wav()), { model: 'clarity-1' })
        .then(() => null, (e: unknown) => e)) as KugelAudioError;
      expect(err).toBeInstanceOf(errorClass);
      expect(err.statusCode).toBe(status);
      expect(err.errorCode).toBe(errorCode);
      expect(err.retryAfter).toBe(retryAfter);
      expect(err.requestId).toBe('req-http');
      expect(err.message).toContain(message);
    },
  );

  it('reports an unexpected success body as a KugelAudioError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true }, 200)));
    await expect(
      client().enhance.generate(await loadAudio(wav()), { model: 'clarity-1' }),
    ).rejects.toBeInstanceOf(KugelAudioError);
  });
});

// ---------------------------------------------------------------------------
// client.enhance.stream
// ---------------------------------------------------------------------------

describe('client.enhance.stream', () => {
  it('sends config, the chunks and end; yields the enhanced chunks until done', async () => {
    const input = await loadAudioStream(wav({ rate: 16000, frames: 4000 }));

    const chunks = await collect(client().enhance.stream(input, { model: 'clarity-1' }));

    expect(chunks.map((c) => c.length)).toEqual([3200, 3200, 1600]);
    const ws = FakeWs.last!;
    const url = new URL(ws.url);
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/v1/audio/enhance/stream');
    expect(url.searchParams.get('api_key')).toBe('test-key');
    expect(url.searchParams.get('sdk')).toBe('js');
    expect(ws.textMessages[0]).toEqual({
      type: 'config',
      model: 'clarity-1',
      task: 'noise_removal',
      sample_rate_hz: 16000,
      encoding: 'pcm_s16le',
    });
    expect(ws.textMessages[ws.textMessages.length - 1]).toEqual({ type: 'end' });
    expect(ws.binaryMessages.map((m) => m.length)).toEqual([3200, 3200, 1600]);
    expect(ws.close).toHaveBeenCalled();
  });

  it('sends the speaker as base64 WAV and switches the task', async () => {
    const speaker = await loadAudio(wav({ frames: 32000 }));
    const input = await loadAudioStream(wav());

    await collect(client().enhance.stream(input, { model: 'clarity-1', speaker }));

    const config = FakeWs.last!.textMessages[0];
    expect(config.task).toBe('target_speaker_extraction');
    expect(Buffer.from(config.speaker_wav_b64 as string, 'base64')).toEqual(Buffer.from(speaker.data));
  });

  it('streams raw async PCM chunks with sampleRate and splits chunks over 1 s', async () => {
    async function* mic() {
      yield new Uint8Array(8000 * 2 * 2.5); // 2.5 s at 8 kHz
      yield new ArrayBuffer(160);
    }
    const chunks = await collect(client().enhance.stream(mic(), { model: 'clarity-1', sampleRate: 8000 }));
    expect(FakeWs.last!.binaryMessages.map((m) => m.length)).toEqual([16000, 16000, 8000, 160]);
    expect(chunks).toHaveLength(4);
  });

  it('validates the input synchronously, before connecting', () => {
    const enhance = client().enhance;
    expect(() => enhance.stream([new Uint8Array(2)], { model: 'clarity-1' })).toThrow(/sampleRate is required/);
    expect(() => enhance.stream('meeting.wav' as any, { model: 'clarity-1' })).toThrow(/loadAudioStream/);
    expect(() => enhance.stream(wav() as any, { model: 'clarity-1', sampleRate: 16000 })).toThrow(ValidationError);
    expect(() => enhance.stream([], { model: '' })).toThrow(ValidationError);
    expect(() => enhance.stream(new AudioStream(new Uint8Array(4), 16000), { model: 'clarity-1', sampleRate: 8000 })).toThrow(/does not match/);
    expect(FakeWs.last).toBeNull();
  });

  it('raises a bad chunk from the sender as a ValidationError', async () => {
    const stream = client().enhance.stream(['not bytes' as any], { model: 'clarity-1', sampleRate: 16000 });
    await expect(collect(stream)).rejects.toThrow(/must be mono PCM16 bytes/);
  });

  type Case = [
    name: string,
    setup: () => void,
    errorClass: typeof KugelAudioError,
    statusCode: number,
    retryAfter: number | undefined,
    requestId: string | undefined,
  ];
  const refuseUpgrade = (statusCode: number, headers: Record<string, string> = {}) => () => {
    FakeWs.refusal = { statusCode, headers };
  };
  const refuseConfig = (frame: object | null, code: number) => () => {
    server = (ws, data) => {
      if (typeof data !== 'string' || JSON.parse(data).type !== 'config') return;
      if (frame) ws.emit(JSON.stringify(frame));
      ws.serverClose(code, '');
    };
  };
  it.each<Case>([
    ['handshake 429', refuseUpgrade(429, { 'retry-after': '7', 'x-request-id': 'req-hs' }), RateLimitError, 429, 7, 'req-hs'],
    ['handshake 429 concurrency', refuseUpgrade(429, { 'x-request-id': 'req-hs' }), RateLimitError, 429, undefined, 'req-hs'],
    ['handshake 402', refuseUpgrade(402), InsufficientCreditsError, 402, undefined, undefined],
    ['handshake 403', refuseUpgrade(403), AuthenticationError, 401, undefined, undefined],
    ['handshake 503', refuseUpgrade(503, { 'retry-after': '5' }), ConnectionError, 503, 5, undefined],
    ['frame then 4029', refuseConfig(RATE_LIMITED_FRAME, 4029), RateLimitError, 429, 7, 'req-ws'],
    ['close 4029 only', refuseConfig(null, 4029), RateLimitError, 429, undefined, undefined],
    ['frame then 4000', refuseConfig(frame(400, 'VALIDATION_ERROR', 'bad rate'), 4000), ValidationError, 400, undefined, 'req-ws'],
    ['close 4001', refuseConfig(null, 4001), AuthenticationError, 401, undefined, undefined],
    ['close 4003', refuseConfig(null, 4003), InsufficientCreditsError, 402, undefined, undefined],
    ['close 4500', refuseConfig(null, 4500), ConnectionError, 503, undefined, undefined],
    ['close 4000', refuseConfig(null, 4000), ConnectionError, 503, undefined, undefined],
    ['close 1011', refuseConfig(null, 1011), ConnectionError, 503, undefined, undefined],
  ])('maps a %s refusal to the same error class as TTS', async (_name, setup, errorClass, statusCode, retryAfter, requestId) => {
    setup();
    const input = await loadAudioStream(wav());
    const err = await collect(client().enhance.stream(input, { model: 'clarity-1' })).catch(
      (e: unknown) => e as KugelAudioError,
    );
    expect(err).toBeInstanceOf(KugelAudioError);
    expect((err as KugelAudioError).constructor).toBe(errorClass);
    expect((err as KugelAudioError).statusCode).toBe(statusCode);
    expect((err as KugelAudioError).retryAfter).toBe(retryAfter);
    expect((err as KugelAudioError).requestId).toBe(requestId);
  });

  it.each<[string, object | null, number, typeof KugelAudioError, number | undefined]>([
    ['frame then 4029', RATE_LIMITED_FRAME, 4029, RateLimitError, 7],
    ['close 4029 only', null, 4029, RateLimitError, undefined],
    ['frame then 4500', frame(503, 'MODEL_UNAVAILABLE', 'backend failed'), 4500, ConnectionError, undefined],
    ['close 4003', null, 4003, InsufficientCreditsError, undefined],
  ])('maps a %s mid-session', async (_name, errorFrame, code, errorClass, retryAfter) => {
    server = (ws, data) => {
      echoServer(ws, data);
      if (data instanceof Uint8Array) {
        if (errorFrame) ws.emit(JSON.stringify(errorFrame));
        ws.serverClose(code, '');
      }
    };
    const received: Uint8Array[] = [];
    const run = async () => {
      for await (const chunk of client().enhance.stream(await loadAudioStream(wav({ frames: 16000 })), { model: 'clarity-1' })) {
        received.push(chunk);
      }
    };
    const err = await run().catch((e: unknown) => e as KugelAudioError);
    expect((err as KugelAudioError).constructor).toBe(errorClass);
    expect((err as KugelAudioError).retryAfter).toBe(retryAfter);
    expect(received).toHaveLength(1);
  });

  it('closes the socket when the caller stops iterating', async () => {
    const input = await loadAudioStream(wav({ frames: 16000 }));
    for await (const chunk of client().enhance.stream(input, { model: 'clarity-1' })) {
      expect(chunk.length).toBe(3200);
      break;
    }
    expect(FakeWs.last!.close).toHaveBeenCalled();
  });
});
