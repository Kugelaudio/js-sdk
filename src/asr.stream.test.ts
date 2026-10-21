/**
 * Live speech to text: `client.asr.stream`.
 *
 * The WebSocket is a scripted fake server speaking the transcription stream
 * protocol (config -> audio_chunk* -> end_of_speech; partial / final /
 * alternatives frames out; close 1000 after the last turn).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioStream } from './audio';
import { KugelAudio } from './client';
import {
  AuthenticationError,
  ConnectionError,
  InsufficientCreditsError,
  KugelAudioError,
  RateLimitError,
  ValidationError,
} from './errors';
import type { StreamingTranscriptionResult } from './types';

type Server = (ws: FakeWs, message: Record<string, unknown>) => void;
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
  sent: Record<string, unknown>[] = [];
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

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener);
  }

  terminate(): void {
    this.readyState = 3;
    this.onerror?.({ error: new Error('WebSocket was closed before the connection was established') });
    this.onclose?.({ code: 1006, reason: '' });
  }

  send(data: unknown): void {
    expect(typeof data).toBe('string'); // audio goes as JSON, never binary
    const message = JSON.parse(data as string);
    this.sent.push(message);
    queueMicrotask(() => server(this, message));
  }

  emit(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }

  get chunks(): Uint8Array[] {
    return this.sent
      .filter((m) => m.type === 'audio_chunk')
      .map((m) => new Uint8Array(Buffer.from(m.audio_b64 as string, 'base64')));
  }
}

const PARTIAL = { type: 'partial', partial_text: 'Hallo', is_final: false, audio_end_s: 4 };
const FINAL = {
  type: 'partial',
  partial_text: 'Hallo Welt',
  is_final: true,
  model: 'stt-model',
  model_revision: 'r1',
  turn_end_reason: 'client_end_of_speech',
  word_alternatives: [],
};
const REVISION = {
  type: 'alternatives',
  partial_text: 'Hallo, Welt.',
  is_final: false,
  model: 'stt-model',
  model_revision: 'r1',
  word_alternatives: [],
  revises_final: true,
  language: 'de',
};

/** One partial after the first chunk; final + revision + close 1000 after end_of_speech. */
const turnServer: Server = (ws, message) => {
  if (message.type === 'audio_chunk' && ws.chunks.length === 1) ws.emit(PARTIAL);
  if (message.type === 'end_of_speech') {
    ws.emit(FINAL);
    ws.emit({ type: 'session_info', note: 'not a transcript frame' });
    ws.emit(REVISION);
    ws.serverClose(1000, '');
  }
};

let server: Server = turnServer;

vi.mock('./websocket', () => ({ getWebSocket: () => FakeWs }));

async function collect(iterable: AsyncIterable<StreamingTranscriptionResult>): Promise<StreamingTranscriptionResult[]> {
  const out: StreamingTranscriptionResult[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const client = () => new KugelAudio({ apiKey: 'test-key' });
/** `seconds` of 16 kHz mono PCM16 with a ramp, so pieces are distinguishable. */
const pcm = (seconds: number, rate = 16000) => {
  const out = new Uint8Array(Math.round(seconds * rate) * 2);
  for (let i = 0; i < out.length; i++) out[i] = i % 251;
  return out;
};

beforeEach(() => {
  server = turnServer;
  FakeWs.last = null;
  FakeWs.refusal = null;
});

describe('client.asr.stream', () => {
  it('sends config, base64 audio and end_of_speech; yields transcript frames until close 1000', async () => {
    const audio = pcm(0.25);
    const events = await collect(client().asr.stream(new AudioStream(audio, 16000, 0.1)));

    expect(events).toEqual([PARTIAL, FINAL, REVISION]);
    expect(events[2].revises_final).toBe(true);
    expect(events[2].language).toBe('de');
    const ws = FakeWs.last!;
    const url = new URL(ws.url);
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/v1/audio/transcriptions/stream');
    expect(url.searchParams.get('api_key')).toBe('test-key');
    expect(url.searchParams.get('sdk')).toBe('js');
    expect(ws.sent[0]).toEqual({ type: 'config', sample_rate: 16000 });
    expect(ws.sent.slice(1, -1).every((m) => m.type === 'audio_chunk')).toBe(true);
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'end_of_speech' });
    expect(Buffer.concat(ws.chunks)).toEqual(Buffer.from(audio));
    expect(ws.close).toHaveBeenCalled();
  });

  it('sends every set option in snake_case, and only those', async () => {
    await collect(
      client().asr.stream([pcm(0.1, 8000)], {
        sampleRate: 8000,
        language: ['de', 'en'],
        model: 'stt-model',
        turnDetection: 'kugelturn',
        turnDetectionLevel: 'conservative',
        boostedPhrases: ['Kratzenstein'],
        projectId: 7,
        dictionaryIds: [],
      }),
    );
    expect(FakeWs.last!.sent[0]).toEqual({
      type: 'config',
      sample_rate: 8000,
      language: ['de', 'en'],
      model: 'stt-model',
      turn_detection: 'kugelturn',
      turn_detection_level: 'conservative',
      boosted_phrases: ['Kratzenstein'],
      project_id: 7,
      dictionary_ids: [],
    });
  });

  it('passes a single language through as a string', async () => {
    await collect(client().asr.stream([pcm(0.1)], { sampleRate: 16000, language: 'de' }));
    expect(FakeWs.last!.sent[0]).toEqual({ type: 'config', sample_rate: 16000, language: 'de' });
  });

  it('splits raw async chunks over 1 s and sends end_of_speech after the last', async () => {
    const big = pcm(2.5, 8000);
    async function* mic() {
      yield big;
      yield new ArrayBuffer(160);
    }
    await collect(client().asr.stream(mic(), { sampleRate: 8000 }));
    const ws = FakeWs.last!;
    expect(ws.chunks.map((c) => c.length)).toEqual([16000, 16000, 8000, 160]);
    expect(Buffer.from(ws.chunks[1])).toEqual(Buffer.from(big.subarray(16000, 32000)));
    expect(ws.sent.map((m) => m.type)).toEqual([
      'config',
      'audio_chunk',
      'audio_chunk',
      'audio_chunk',
      'audio_chunk',
      'end_of_speech',
    ]);
  });

  it('validates the input synchronously, before connecting', () => {
    const asr = client().asr;
    expect(() => asr.stream([new Uint8Array(2)])).toThrow(ValidationError);
    expect(() => asr.stream([new Uint8Array(2)])).toThrow(/sampleRate is required/);
    expect(() => asr.stream('call.wav' as any)).toThrow(/loadAudioStream/);
    expect(() => asr.stream(pcm(0.1) as any, { sampleRate: 16000 })).toThrow(ValidationError);
    expect(() => asr.stream([], { sampleRate: 0 })).toThrow(ValidationError);
    expect(() => asr.stream(new AudioStream(new Uint8Array(4), 16000), { sampleRate: 8000 })).toThrow(
      /does not match/,
    );
    expect(() => asr.stream(new AudioStream(new Uint8Array(4), 16000), { sampleRate: 8000 })).toThrow(
      ValidationError,
    );
    expect(FakeWs.last).toBeNull();
  });

  it('raises a bad chunk from the sender as a ValidationError', async () => {
    server = () => {};
    const stream = client().asr.stream(['not bytes' as any], { sampleRate: 16000 });
    await expect(collect(stream)).rejects.toThrow(/must be mono PCM16 bytes/);
  });

  it.each<[string, object, typeof KugelAudioError, number]>([
    ['422 validation', { error: 'turn_detection_level needs kugelturn', error_code: 'VALIDATION_ERROR', code: 422 }, ValidationError, 422],
    ['402 credits', { error: 'Insufficient credits', error_code: 'INSUFFICIENT_CREDITS', code: 402 }, InsufficientCreditsError, 402],
    ['429 rate limit', { error: 'Rate limit exceeded', error_code: 'RATE_LIMITED', code: 429, request_id: 'req-ws' }, RateLimitError, 429],
  ])('throws a %s error frame as its typed error', async (_name, errorFrame, errorClass, statusCode) => {
    server = (ws, message) => {
      if (message.type !== 'config') return;
      ws.emit(errorFrame);
      ws.serverClose(4000, '');
    };
    const err = (await collect(client().asr.stream([pcm(0.1)], { sampleRate: 16000 })).catch(
      (e: unknown) => e,
    )) as KugelAudioError;
    expect(err.constructor).toBe(errorClass);
    expect(err.statusCode).toBe(statusCode);
  });

  it.each<[number, typeof KugelAudioError]>([
    [1011, ConnectionError],
    [4003, InsufficientCreditsError],
    [1012, KugelAudioError],
  ])('throws on a close %i after yielding what arrived', async (code, errorClass) => {
    server = (ws, message) => {
      if (message.type !== 'end_of_speech') return;
      ws.emit(FINAL);
      ws.serverClose(code, 'stream failed');
    };
    const received: StreamingTranscriptionResult[] = [];
    const run = async () => {
      for await (const event of client().asr.stream([pcm(0.1)], { sampleRate: 16000 })) received.push(event);
    };
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(errorClass);
    expect(received).toEqual([FINAL]);
  });

  it.each<[number, Record<string, string>, typeof KugelAudioError, number | undefined]>([
    [401, {}, AuthenticationError, undefined],
    [402, {}, InsufficientCreditsError, undefined],
    [403, {}, AuthenticationError, undefined],
    [429, { 'retry-after': '7', 'x-request-id': 'req-hs' }, RateLimitError, 7],
    [503, {}, ConnectionError, undefined],
  ])('throws a refused handshake %i as its typed error', async (statusCode, headers, errorClass, retryAfter) => {
    FakeWs.refusal = { statusCode, headers };
    const err = (await collect(client().asr.stream([pcm(0.1)], { sampleRate: 16000 })).catch(
      (e: unknown) => e,
    )) as KugelAudioError;
    expect(err.constructor).toBe(errorClass);
    expect(err.retryAfter).toBe(retryAfter);
  });

  it('closes the socket and stops sending when the caller breaks out', async () => {
    server = (ws, message) => {
      if (message.type === 'audio_chunk' && ws.chunks.length === 1) ws.emit(PARTIAL);
    };
    function* endless() {
      for (;;) yield pcm(0.1);
    }
    for await (const event of client().asr.stream(endless(), { sampleRate: 16000 })) {
      expect(event).toEqual(PARTIAL);
      break;
    }
    const ws = FakeWs.last!;
    expect(ws.close).toHaveBeenCalled();
    const sentAtBreak = ws.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ws.sent.length).toBe(sentAtBreak);
    expect(ws.sent.some((m) => m.type === 'end_of_speech')).toBe(false);
  });
});
