/**
 * KugelAudio speech-to-text plugin for the LiveKit Agents (Node.js) framework.
 *
 * The TypeScript counterpart of `kugelaudio.livekit.STT` in the Python SDK.
 * A {@link SpeechStream} feeds the session's audio into `client.asr.stream`
 * and turns its frames into LiveKit speech events. The server detects the end
 * of each turn, so use it with `turnHandling: { turnDetection: 'stt' }`: the
 * turn's final frame becomes FINAL_TRANSCRIPT followed by END_OF_SPEECH.
 */

import {
  APIConnectionError,
  APIError,
  APIStatusError,
  type APIConnectOptions,
  type AudioBuffer,
  log,
  mergeFrames,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

import type { TranscriptionStreamOptions } from '../asr';
import { KugelAudio } from '../client';
import {
  AuthenticationError,
  ConnectionError,
  InsufficientCreditsError,
  KugelAudioError,
  ValidationError,
} from '../errors';
import type { Region, StreamingTranscriptionResult, TranscribeOptions } from '../types';
import { createWavFile } from '../utils';

/** Sample rate the audio is resampled to before it is sent, in Hz. */
export const DEFAULT_STT_SAMPLE_RATE = 16000;

/** Options accepted by the {@link STT} constructor. Every option is optional; unset ones are not sent. */
export interface STTOptions {
  /**
   * KugelAudio API key. Falls back to the `KUGELAUDIO_API_KEY` environment
   * variable. An `eu-` / `us-` / `global-` prefix selects the region and is
   * stripped before auth.
   */
  apiKey?: string;
  /** Deployment region; `'eu'` selects the direct EU endpoint. Overrides the key prefix, not `baseURL`. */
  region?: Region;
  /** API base URL. Overrides the default geo-routed endpoint. */
  baseURL?: string;
  /** Speech-to-text model ID, sent as given. Omit it for the server's default model. */
  model?: string;
  /** A language code such as `'en'`, several the audio may be in, or `'auto'`. */
  language?: string | string[];
  /** Who ends a turn: `'kugelturn'` (server default), `'vad'` or `'manual'`. */
  turnDetection?: 'kugelturn' | 'vad' | 'manual';
  /** How readily KugelTurn ends a turn; only with `turnDetection: 'kugelturn'`. */
  turnDetectionLevel?: 'responsive' | 'conservative';
  /** Names, brands and domain terms to spell as written. */
  boostedPhrases?: string[];
  /** The project whose dictionaries apply. Omit it to use the API key's project. */
  projectId?: number;
  /** The project dictionaries to apply. Omit it for every active one; `[]` applies none. */
  dictionaryIds?: number[];
  /** Sample rate the audio is resampled to before sending, in Hz. Defaults to 16000. */
  sampleRate?: number;
}

type StreamOptions = TranscriptionStreamOptions & { sampleRate: number };

/** `obj` without its `undefined` values, so an unset option is never sent. */
function defined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** The language a transcript carries: the configured single code, else `''` (unknown). */
function transcriptLanguage(language: string | string[] | undefined): string {
  const single = Array.isArray(language) ? (language.length === 1 ? language[0] : undefined) : language;
  return single && single.toLowerCase() !== 'auto' ? single : '';
}

/**
 * Map an SDK error to the LiveKit error type with its retryability: auth,
 * credits and validation are final; rate limits and connection failures are
 * retried by the framework. Anything that is not an SDK error is returned
 * unchanged, so a bug is never retried as if it were the network.
 * @internal
 */
export function toLiveKitError(error: unknown): unknown {
  if (error instanceof APIError || !(error instanceof KugelAudioError)) return error;
  if (error instanceof ConnectionError) {
    return new APIConnectionError({ message: error.message, options: { retryable: true } });
  }
  const final =
    error instanceof AuthenticationError ||
    error instanceof InsufficientCreditsError ||
    error instanceof ValidationError;
  return new APIStatusError({
    message: error.message,
    options: {
      statusCode: error.statusCode ?? -1,
      requestId: error.requestId ?? null,
      retryable: !final,
    },
  });
}

/**
 * A mono frame's samples as PCM16 bytes. The API transcribes mono only, so a
 * multi-channel frame is refused rather than mixed down.
 */
function pcm16Mono(frame: AudioFrame): Uint8Array {
  if (frame.channels !== 1) {
    throw new Error(`KugelAudio speech to text takes mono audio; got a frame with ${frame.channels} channels.`);
  }
  const data = frame.data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** The one language code an upload can carry; a list of several cannot be expressed there. */
function uploadLanguage(language: string | string[] | undefined): string | undefined {
  if (!Array.isArray(language)) return language;
  if (language.length === 1) return language[0];
  throw new Error(
    'recognize() uploads one recording, which takes a single language code; ' +
      `the STT is configured with ${JSON.stringify(language)}. Use stream() to detect among several.`,
  );
}

/** Resolve `request`, or reject with the signal's reason once it aborts. */
function abortable<T>(request: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return request;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([request, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/**
 * KugelAudio speech-to-text plugin for LiveKit Agents.
 *
 * @example
 * ```ts
 * import { voice } from '@livekit/agents';
 * import * as silero from '@livekit/agents-plugin-silero';
 * import { STT } from 'kugelaudio/livekit';
 *
 * const session = new voice.AgentSession({
 *   stt: new STT({ language: 'en' }),
 *   turnHandling: { turnDetection: 'stt' }, // KugelAudio's server-side end of turn drives turns
 *   vad: await silero.VAD.load(),
 *   // ...llm, tts
 * });
 * ```
 */
export class STT extends stt.STT {
  label = 'kugelaudio.STT';
  #client: KugelAudio;
  #options: StreamOptions;
  #language: string;
  #streams = new Set<SpeechStream>();

  constructor(opts: STTOptions = {}) {
    super({ streaming: true, interimResults: true });

    const apiKey = opts.apiKey ?? process.env.KUGELAUDIO_API_KEY;
    if (!apiKey) {
      throw new Error(
        'KUGELAUDIO_API_KEY must be set or apiKey must be provided to the STT constructor.',
      );
    }
    const sampleRate = opts.sampleRate ?? DEFAULT_STT_SAMPLE_RATE;
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error(`KugelAudio STT: sampleRate must be a positive integer in Hz, got ${sampleRate}.`);
    }

    // The client resolves the region exactly as the TTS plugin does:
    // baseURL first, then `region`, then the key's prefix.
    this.#client = new KugelAudio({ apiKey, region: opts.region, apiUrl: opts.baseURL });
    this.#options = defined({
      sampleRate,
      model: opts.model,
      language: opts.language,
      turnDetection: opts.turnDetection,
      turnDetectionLevel: opts.turnDetectionLevel,
      boostedPhrases: opts.boostedPhrases,
      projectId: opts.projectId,
      dictionaryIds: opts.dictionaryIds,
    });
    this.#language = transcriptLanguage(opts.language);
  }

  get model(): string {
    return this.#options.model ?? super.model;
  }

  get provider(): string {
    return 'KugelAudio';
  }

  /** One-shot transcription of a buffer through `client.asr.transcribe`. */
  protected async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const frame = mergeFrames(buffer);
    const pcm = pcm16Mono(frame).slice();
    const wav = createWavFile(pcm.buffer as ArrayBuffer, frame.sampleRate);
    const { model, language, boostedPhrases, projectId, dictionaryIds } = this.#options;
    const request: TranscribeOptions = defined({
      audio: new Blob([wav], { type: 'audio/wav' }),
      filename: 'audio.wav',
      model,
      language: uploadLanguage(language),
      boostedPhrases,
      projectId,
      dictionaryIds,
    });
    let response;
    try {
      response = await abortable(this.#client.asr.transcribe(request), abortSignal);
    } catch (error) {
      throw toLiveKitError(error);
    }
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: (response.text ?? response.transcript ?? '').trim(),
          language: (this.#language || response.language || '') as stt.SpeechData['language'],
          startTime: 0,
          endTime: frame.samplesPerChannel / frame.sampleRate,
          confidence: 0,
        },
      ],
    };
  }

  stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
    const stream = new SpeechStream(
      this,
      this.#client,
      { ...this.#options },
      this.#language,
      options?.connOptions,
      () => this.#streams.delete(stream),
    );
    this.#streams.add(stream);
    return stream;
  }

  async close(): Promise<void> {
    for (const stream of [...this.#streams]) stream.close();
    this.#client.close();
  }
}

/**
 * A live transcription stream: audio frames in, LiveKit speech events out.
 *
 * Each frame of the server maps to events as follows. The first non-empty
 * partial of a turn emits START_OF_SPEECH, then INTERIM_TRANSCRIPT (the full
 * rolling hypothesis). The turn's final emits START_OF_SPEECH if none was
 * sent, FINAL_TRANSCRIPT, END_OF_SPEECH and RECOGNITION_USAGE; an empty final
 * of a turn that never started emits nothing. `alternatives` frames are
 * ignored: the final already committed the turn.
 *
 * Audio is resampled to the configured sample rate. It must be mono, because
 * the API transcribes mono PCM16; a multi-channel frame fails the stream.
 */
export class SpeechStream extends stt.SpeechStream {
  label = 'kugelaudio.SpeechStream';
  #client: KugelAudio;
  #options: StreamOptions;
  #language: string;
  #onClose: () => void;
  #logger = log();
  #alternativesLogged = false;
  /** START_OF_SPEECH was emitted and the turn has not ended. Survives a reconnect. */
  #speaking = false;
  /** Seconds of audio sent in the current run, the time base of transcript timestamps. */
  #runAudio = 0;
  /** Stream time (seconds) where the current turn began. */
  #turnStart = 0;
  /** Seconds of audio sent over the whole stream, and how much of it was reported as usage. */
  #audioSent = 0;
  #audioReported = 0;

  constructor(
    sttInstance: STT,
    client: KugelAudio,
    options: StreamOptions,
    language: string,
    connOptions: APIConnectOptions | undefined,
    onClose: () => void,
  ) {
    super(sttInstance, options.sampleRate, connOptions);
    this.#client = client;
    this.#options = options;
    this.#language = language;
    this.#onClose = onClose;
  }

  /**
   * Refuses a multi-channel frame here, before the base class resamples it:
   * LiveKit's resampler is mono and would read interleaved stereo as one channel.
   */
  pushFrame(frame: AudioFrame): void {
    if (frame.channels !== 1) {
      throw new Error(`KugelAudio speech to text takes mono audio; got a frame with ${frame.channels} channels.`);
    }
    super.pushFrame(frame);
  }

  close(): void {
    super.close();
    this.#onClose();
  }

  protected async run(): Promise<void> {
    this.#runAudio = 0;
    if (!this.#speaking) this.#turnStart = this.startTimeOffset;
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    this.abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      const events = this.#client.asr.stream(this.#audio(stop.signal), this.#options);
      const closed = new Promise<null>((resolve) => stop.signal.addEventListener('abort', () => resolve(null), { once: true }));
      for (;;) {
        const pending = events.next();
        const next = await Promise.race([pending, closed]);
        if (next === null) {
          // The stream was closed: stop now rather than wait for the server's
          // last turn. KEEP-JUSTIFIED: a late rejection belongs to a stream
          // the caller closed; nobody reads it any more.
          pending.catch(() => {});
          void events.return(undefined).catch(() => {});
          return;
        }
        if (next.done) break;
        this.#handle(next.value);
      }
      if (!this.input.closed) {
        throw new APIConnectionError({
          message: 'KugelAudio closed the transcription stream before the audio ended',
          options: { retryable: true },
        });
      }
      this.#reportUsage();
    } catch (error) {
      throw toLiveKitError(error);
    } finally {
      stop.abort();
      this.abortSignal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The input frames as mono PCM16 bytes. It ends when the input ends, which
   * makes the SDK send `end_of_speech`; flush requests are skipped because
   * `end_of_speech` would end the whole connection. `signal` ends it when
   * its run is over, leaving unread frames for the next run.
   */
  async *#audio(signal: AbortSignal): AsyncGenerator<Uint8Array> {
    for (;;) {
      let item: IteratorResult<AudioFrame | symbol>;
      try {
        item = await this.input.next({ signal });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (item.done) return;
      const frame = item.value;
      if (typeof frame === 'symbol' || frame.samplesPerChannel === 0) continue;
      const seconds = frame.samplesPerChannel / frame.sampleRate;
      this.#runAudio += seconds;
      this.#audioSent += seconds;
      yield pcm16Mono(frame);
    }
  }

  #handle(event: StreamingTranscriptionResult): void {
    if (event.type !== 'partial') {
      if (!this.#alternativesLogged) {
        this.#alternativesLogged = true;
        this.#logger.debug('KugelAudio STT ignores alternatives frames; the final already drove the turn');
      }
      return;
    }
    const text = (event.partial_text ?? '').trim();
    if (!event.is_final) {
      if (!text) return;
      this.#startTurn();
      this.#put({ type: stt.SpeechEventType.INTERIM_TRANSCRIPT, alternatives: [this.#data(text)] });
      return;
    }
    if (!text && !this.#speaking) return;
    this.#startTurn();
    this.#put({ type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [this.#data(text)] });
    this.#put({ type: stt.SpeechEventType.END_OF_SPEECH });
    this.#reportUsage();
    this.#speaking = false;
    this.#turnStart = this.#now();
  }

  #startTurn(): void {
    if (this.#speaking) return;
    this.#speaking = true;
    this.#put({ type: stt.SpeechEventType.START_OF_SPEECH });
  }

  #reportUsage(): void {
    const audioDuration = this.#audioSent - this.#audioReported;
    if (audioDuration <= 0) return;
    this.#audioReported = this.#audioSent;
    this.#put({ type: stt.SpeechEventType.RECOGNITION_USAGE, recognitionUsage: { audioDuration } });
  }

  #now(): number {
    return this.startTimeOffset + this.#runAudio;
  }

  #data(text: string): stt.SpeechData {
    return {
      text,
      language: this.#language as stt.SpeechData['language'],
      startTime: this.#turnStart,
      endTime: this.#now(),
      confidence: 0,
    };
  }

  #put(event: stt.SpeechEvent): void {
    if (!this.queue.closed) this.queue.put(event);
  }
}
