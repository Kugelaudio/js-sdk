/**
 * The LiveKit STT plugin over a scripted `client.asr.stream` (no network).
 *
 * The fake reads the audio the plugin sends, like the real stream does, and
 * yields scripted server frames. The wire protocol itself is covered by
 * `../asr.stream.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  APIConnectionError,
  APIError,
  APIStatusError,
  initializeLogger,
  stt as lkstt,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';

import { ASRResource } from '../asr';
import {
  AuthenticationError,
  ConnectionError,
  InsufficientCreditsError,
  KugelAudioError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../errors';
import type { StreamingTranscriptionResult, TranscribeOptions } from '../types';
import { STT, SpeechStream, toLiveKitError } from './stt';

const T = lkstt.SpeechEventType;
/** A server frame; `throws` fails the stream there, `endEarly` closes it without reading the rest of the audio. */
type Step = Partial<StreamingTranscriptionResult> & { afterChunks?: number; throws?: Error; endEarly?: boolean };
type STTErrorEvent = { error: Error; recoverable: boolean };
type Call = { options: Record<string, unknown>; chunks: Uint8Array[]; ended: boolean };

const SAMPLES = 160; // 10 ms at 16 kHz
const open: STT[] = [];

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(async () => {
  for (const instance of open.splice(0)) await instance.close();
  vi.restoreAllMocks();
});

function makeSTT(opts: ConstructorParameters<typeof STT>[0] = {}): STT {
  const instance = new STT({ apiKey: 'test-key', ...opts });
  open.push(instance);
  return instance;
}

function frame(value = 1, sampleRate = 16000, channels = 1): AudioFrame {
  const data = new Int16Array(SAMPLES * channels).fill(value);
  return new AudioFrame(data, sampleRate, channels, SAMPLES);
}

/**
 * Script `client.asr.stream`: each run consumes the audio in the background
 * and yields its steps; `afterChunks` holds a step until that many chunks
 * arrived (or the audio ended). A run whose script is an Error throws it.
 */
function scriptStream(...runs: Array<Step[] | Error>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(ASRResource.prototype, 'stream').mockImplementation((audio, options) => {
    const call: Call = { options: { ...options }, chunks: [], ended: false };
    calls.push(call);
    const script = runs[calls.length - 1] ?? [];
    return (async function* () {
      if (script instanceof Error) throw script;
      let wake = () => {};
      const consumer = (async () => {
        for await (const chunk of audio as AsyncIterable<Uint8Array>) {
          call.chunks.push(chunk.slice());
          wake();
        }
        call.ended = true;
        wake();
      })();
      for (const { afterChunks = 0, throws, endEarly, ...step } of script) {
        while (call.chunks.length < afterChunks && !call.ended) {
          await new Promise<void>((resolve) => (wake = resolve));
        }
        if (throws) throw throws;
        if (endEarly) return;
        yield { type: 'partial', partial_text: '', is_final: false, word_alternatives: [], ...step };
      }
      await consumer;
    })();
  });
  return calls;
}

/** Push `frames`, end the input, and collect every event the stream emits. */
async function run(stream: SpeechStream, frames: AudioFrame[]): Promise<lkstt.SpeechEvent[]> {
  for (const f of frames) stream.pushFrame(f);
  stream.endInput();
  const events: lkstt.SpeechEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const frames = (n: number) => Array.from({ length: n }, () => frame());
const kinds = (events: lkstt.SpeechEvent[]) => events.filter((e) => e.type !== T.RECOGNITION_USAGE).map((e) => e.type);
const texts = (events: lkstt.SpeechEvent[], type: lkstt.SpeechEventType) =>
  events.filter((e) => e.type === type).map((e) => e.alternatives![0].text);
const usage = (events: lkstt.SpeechEvent[]) =>
  events.filter((e) => e.type === T.RECOGNITION_USAGE).reduce((s, e) => s + e.recognitionUsage!.audioDuration, 0);

describe('kugelaudio/livekit STT stream', () => {
  it('a short turn with only a final emits start, final and end, with language and usage', async () => {
    scriptStream([{ partial_text: 'hello there', is_final: true, afterChunks: 10 }]);
    const events = await run(makeSTT({ language: 'en' }).stream(), frames(10));

    expect(kinds(events)).toEqual([T.START_OF_SPEECH, T.FINAL_TRANSCRIPT, T.END_OF_SPEECH]);
    const final = events.find((e) => e.type === T.FINAL_TRANSCRIPT)!.alternatives![0];
    expect(final.text).toBe('hello there');
    expect(final.language).toBe('en');
    expect(final.endTime).toBeCloseTo(0.1, 6);
    expect(usage(events)).toBeCloseTo(0.1, 6);
  });

  it('partials become interim transcripts (full text, replace), then the final ends the turn', async () => {
    scriptStream([
      { partial_text: '', afterChunks: 2 },
      { partial_text: 'hello', afterChunks: 4 },
      { partial_text: 'hello wor', afterChunks: 6 },
      { partial_text: 'hello world', is_final: true },
    ]);
    const events = await run(makeSTT().stream(), frames(8));

    expect(kinds(events)).toEqual([
      T.START_OF_SPEECH,
      T.INTERIM_TRANSCRIPT,
      T.INTERIM_TRANSCRIPT,
      T.FINAL_TRANSCRIPT,
      T.END_OF_SPEECH,
    ]);
    expect(texts(events, T.INTERIM_TRANSCRIPT)).toEqual(['hello', 'hello wor']);
    expect(texts(events, T.FINAL_TRANSCRIPT)).toEqual(['hello world']);
    // No single language configured: the language is unknown, never guessed.
    expect(events.find((e) => e.type === T.FINAL_TRANSCRIPT)!.alternatives![0].language).toBe('');
  });

  it('two turns on one stream each get their own start and end; usage covers all audio', async () => {
    scriptStream([
      { partial_text: 'first', afterChunks: 2 },
      { partial_text: 'first turn', is_final: true, afterChunks: 3 },
      { partial_text: 'second turn', is_final: true, afterChunks: 6 },
    ]);
    const events = await run(makeSTT({ language: ['de', 'en'] }).stream(), frames(6));

    expect(kinds(events)).toEqual([
      T.START_OF_SPEECH,
      T.INTERIM_TRANSCRIPT,
      T.FINAL_TRANSCRIPT,
      T.END_OF_SPEECH,
      T.START_OF_SPEECH,
      T.FINAL_TRANSCRIPT,
      T.END_OF_SPEECH,
    ]);
    expect(texts(events, T.FINAL_TRANSCRIPT)).toEqual(['first turn', 'second turn']);
    const [first, second] = events.filter((e) => e.type === T.FINAL_TRANSCRIPT).map((e) => e.alternatives![0]);
    expect(second!.startTime).toBeCloseTo(first!.endTime, 6);
    expect(first!.language).toBe(''); // several languages configured: unknown
    expect(usage(events)).toBeCloseTo(0.06, 6);
  });

  it('ignores alternatives frames, including a revision of the final', async () => {
    scriptStream([
      { partial_text: 'hello', is_final: true },
      { type: 'alternatives', partial_text: 'hallo', revises_final: true, language: 'de' },
      { type: 'alternatives', partial_text: 'hullo' },
    ]);
    const events = await run(makeSTT().stream(), frames(3));

    expect(kinds(events)).toEqual([T.START_OF_SPEECH, T.FINAL_TRANSCRIPT, T.END_OF_SPEECH]);
    expect(texts(events, T.FINAL_TRANSCRIPT)).toEqual(['hello']);
  });

  it('an empty final of a turn that never started emits nothing', async () => {
    scriptStream([
      { partial_text: '  ', is_final: true },
      { partial_text: 'real words', is_final: true },
    ]);
    const events = await run(makeSTT().stream(), frames(3));

    expect(kinds(events)).toEqual([T.START_OF_SPEECH, T.FINAL_TRANSCRIPT, T.END_OF_SPEECH]);
    expect(texts(events, T.FINAL_TRANSCRIPT)).toEqual(['real words']);
  });

  it('an empty final of a started turn still ends it', async () => {
    scriptStream([{ partial_text: 'uh', afterChunks: 1 }, { partial_text: '', is_final: true }]);
    const events = await run(makeSTT().stream(), frames(2));

    expect(kinds(events)).toEqual([T.START_OF_SPEECH, T.INTERIM_TRANSCRIPT, T.FINAL_TRANSCRIPT, T.END_OF_SPEECH]);
  });

  it('sends every frame as mono PCM16 and ends the audio iterable when the input ends', async () => {
    const calls = scriptStream([]);
    const events = await run(makeSTT().stream(), [frame(7), frame(-3)]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.ended).toBe(true);
    const sent = calls[0]!.chunks;
    expect(sent.map((c) => c.byteLength)).toEqual([SAMPLES * 2, SAMPLES * 2]);
    expect(new Int16Array(sent[1]!.buffer)[0]).toBe(-3);
    // Audio after the last final is still reported as usage.
    expect(usage(events)).toBeCloseTo(0.02, 6);
  });

  it('skips flush requests instead of ending the connection', async () => {
    const calls = scriptStream([]);
    const stream = makeSTT().stream();
    stream.pushFrame(frame(4));
    stream.flush();
    await run(stream, [frame(5)]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.chunks).toHaveLength(2);
    expect(new Int16Array(calls[0]!.chunks[1]!.buffer)[0]).toBe(5);
  });

  it('refuses a stereo frame before the base class resamples it', async () => {
    const calls = scriptStream([]);
    const stream = makeSTT().stream();
    const stereo = new AudioFrame(new Int16Array(960 * 2), 48000, 2, 960);
    expect(() => stream.pushFrame(stereo)).toThrow(/mono/);
    await run(stream, []);
    expect(calls[0]!.chunks).toHaveLength(0);
  });

  it('refuses multi-channel audio for a one-shot recognize', async () => {
    const instance = makeSTT();
    const stereo = new AudioFrame(new Int16Array(SAMPLES * 2), 16000, 2, SAMPLES);
    const error = await instance.recognize(stereo).catch((e: unknown) => e);
    expect(String(error)).toContain('mono');
  });

  it('sends only the options that were set', async () => {
    const calls = scriptStream([], []);
    await run(makeSTT().stream(), frames(1));
    await run(
      makeSTT({
        model: 'test-model',
        language: 'auto',
        turnDetection: 'kugelturn',
        turnDetectionLevel: 'conservative',
        boostedPhrases: ['KugelAudio'],
        projectId: 7,
        dictionaryIds: [],
        sampleRate: 24000,
      }).stream(),
      [frame(1, 24000)],
    );

    expect(calls[0]!.options).toStrictEqual({ sampleRate: 16000 });
    expect(calls[1]!.options).toStrictEqual({
      sampleRate: 24000,
      model: 'test-model',
      language: 'auto',
      turnDetection: 'kugelturn',
      turnDetectionLevel: 'conservative',
      boostedPhrases: ['KugelAudio'],
      projectId: 7,
      dictionaryIds: [],
    });
  });

  it('reconnects after a retryable error and keeps the turn open across the reconnect', async () => {
    const calls = scriptStream(
      [{ partial_text: 'hel', afterChunks: 1 }, { throws: new RateLimitError(), afterChunks: 2 }],
      [{ partial_text: 'hello', is_final: true }],
    );
    const instance = makeSTT();
    const errors: unknown[] = [];
    instance.on('error', (e) => errors.push(e));
    const stream = instance.stream({ connOptions: { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 } });
    const events = await run(stream, frames(3));

    expect(calls).toHaveLength(2);
    expect(errors).toEqual([]);
    // One START for the turn that spans the reconnect.
    expect(kinds(events)).toEqual([T.START_OF_SPEECH, T.INTERIM_TRANSCRIPT, T.FINAL_TRANSCRIPT, T.END_OF_SPEECH]);
  });

  it('a non-retryable error ends the stream with one unrecoverable error event', async () => {
    const calls = scriptStream([{ throws: new AuthenticationError() }]);
    const instance = makeSTT();
    const errors: STTErrorEvent[] = [];
    instance.on('error', (e) => errors.push(e));
    await run(instance.stream({ connOptions: { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 1000 } }), frames(1));

    expect(calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(false);
    expect(errors[0]!.error).toBeInstanceOf(APIStatusError);
    expect((errors[0]!.error as APIStatusError).statusCode).toBe(401);
    expect((errors[0]!.error as APIStatusError).retryable).toBe(false);
  });

  it('a server close before the audio ended is a retryable connection error', async () => {
    const calls = scriptStream([{ endEarly: true }]);
    const instance = makeSTT();
    const errors: STTErrorEvent[] = [];
    instance.on('error', (e) => errors.push(e));
    const stream = instance.stream({ connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 } });
    stream.pushFrame(frame()); // the input stays open
    for await (const _ of stream) {
      // drain until the failed stream ends
    }
    stream.close();

    expect(calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(APIConnectionError);
    expect((errors[0]!.error as APIError).retryable).toBe(true);
  });

  it('close() mid-stream stops the run without waiting for the server', async () => {
    const calls = scriptStream([{ partial_text: 'never', afterChunks: 99 }]);
    const stream = makeSTT().stream();
    stream.pushFrame(frame());
    while (calls.length === 0 || calls[0]!.chunks.length === 0) await new Promise((r) => setTimeout(r, 1));
    stream.close();
    const events: lkstt.SpeechEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([]);
  });
});

describe('error mapping', () => {
  it.each([
    [new AuthenticationError(), APIStatusError, false, 401],
    [new InsufficientCreditsError(), APIStatusError, false, 402],
    [new ValidationError('bad'), APIStatusError, false, 400],
    [new NotFoundError(), APIStatusError, false, 404],
    [new RateLimitError(), APIStatusError, true, 429],
    [new KugelAudioError('internal', { statusCode: 500 }), APIStatusError, true, 500],
    [new ConnectionError('down'), APIConnectionError, true, undefined],
  ])('%s maps with the right retryability', (error, type, retryable, status) => {
    const mapped = toLiveKitError(error) as APIError;
    expect(mapped).toBeInstanceOf(type);
    expect(mapped.retryable).toBe(retryable);
    expect(mapped.message).toBe(error.message);
    if (status !== undefined) expect((mapped as APIStatusError).statusCode).toBe(status);
  });

  it('passes errors that are not from the SDK through unchanged', () => {
    const bug = new TypeError('bug');
    expect(toLiveKitError(bug)).toBe(bug);
  });
});

describe('kugelaudio/livekit STT recognize', () => {
  it('uploads the buffer as one mono WAV and returns its final transcript', async () => {
    const requests: TranscribeOptions[] = [];
    vi.spyOn(ASRResource.prototype, 'transcribe').mockImplementation(async (options) => {
      requests.push(options);
      return { text: ' hello world ', transcript: 'hello world', language: 'de', duration_s: 0.02, model: 'test-model', word_alternatives: [] };
    });
    const instance = makeSTT({ model: 'test-model', boostedPhrases: ['Kugel'] });
    const event = await instance.recognize([frame(5, 8000), frame(6, 8000)]);

    expect(event.type).toBe(T.FINAL_TRANSCRIPT);
    expect(event.alternatives![0].text).toBe('hello world');
    expect(event.alternatives![0].language).toBe('de'); // the server's answer, not a guess
    expect(event.alternatives![0].endTime).toBeCloseTo(0.04, 6);

    const { audio, ...rest } = requests[0]!;
    expect(rest).toStrictEqual({ filename: 'audio.wav', model: 'test-model', boostedPhrases: ['Kugel'] });
    const wav = new DataView(await audio.arrayBuffer());
    expect(wav.byteLength).toBe(44 + 2 * SAMPLES * 2);
    expect(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3))).toBe('RIFF');
    expect(wav.getUint32(24, true)).toBe(8000);
    expect(wav.getInt16(44, true)).toBe(5);
  });

  it('maps a failed upload to the LiveKit error type', async () => {
    vi.spyOn(ASRResource.prototype, 'transcribe').mockRejectedValue(new InsufficientCreditsError());
    const error = await makeSTT({ language: 'en' }).recognize(frame()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).retryable).toBe(false);
  });

  it('refuses a list of several languages, which an upload cannot carry', async () => {
    const transcribe = vi.spyOn(ASRResource.prototype, 'transcribe');
    const error = await makeSTT({ language: ['de', 'en'] }).recognize(frame()).catch((e: unknown) => e);

    expect(String(error)).toContain('single language code');
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe('kugelaudio/livekit STT construction', () => {
  it('needs an API key and a positive integer sample rate', () => {
    const saved = process.env.KUGELAUDIO_API_KEY;
    delete process.env.KUGELAUDIO_API_KEY;
    try {
      expect(() => new STT()).toThrow(/KUGELAUDIO_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.KUGELAUDIO_API_KEY = saved;
    }
    expect(() => new STT({ apiKey: 'k', sampleRate: 0 })).toThrow(/sampleRate/);
  });

  it('advertises streaming with interim results and names its provider and model', () => {
    const instance = makeSTT({ model: 'test-model' });
    expect(instance.capabilities).toMatchObject({ streaming: true, interimResults: true });
    expect(instance.provider).toBe('KugelAudio');
    expect(instance.model).toBe('test-model');
    expect(makeSTT().model).toBe('unknown');
  });
});
