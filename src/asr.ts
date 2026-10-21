/**
 * Speech to text: `client.asr`.
 *
 * `transcribe` uploads a recording; `stream` transcribes live audio over a
 * WebSocket and yields partial, final and revision frames as they arrive.
 *
 * @example
 * ```typescript
 * const audio = await loadAudioStream('call.wav'); // mono 16-bit WAV
 * for await (const event of client.asr.stream(audio)) {
 *   if (event.revises_final) console.log('revised:', event.partial_text, event.language);
 *   else if (event.is_final) console.log('final:', event.partial_text, event.turn_end_reason);
 * }
 * ```
 */

import { AudioStream, LoadedAudio, isBinary } from './audio';
import type { KugelAudio } from './client';
import type { PcmChunk } from './enhance';
import { ValidationError, classifyWsClose, classifyWsFrame } from './errors';
import { captureHandshakeRejection } from './handshake';
import { EventQueue, openSocket, parseText, sleep } from './socket-stream';
import type {
  StreamingTranscriptionConfig,
  StreamingTranscriptionResult,
  TranscribeOptions,
  TranscriptionResponse,
} from './types';
import { arrayBufferToBase64 } from './utils';
import { getWebSocket, loadWebSocket } from './websocket';

const TRANSCRIBE_PATH = '/v1/audio/transcriptions';
const STREAM_PATH = '/v1/audio/transcriptions/stream';
const END_OF_SPEECH = JSON.stringify({ type: 'end_of_speech' });
const WS_OPEN = 1;
const WS_NORMAL_CLOSE = 1000;
const SEND_HIGH_WATER_BYTES = 1 << 20;

/** Options for `client.asr.stream`. Only the options you set are sent. */
export interface TranscriptionStreamOptions {
  /**
   * Sample rate of raw PCM16 chunks in Hz. Required for raw chunks; taken
   * from an {@link AudioStream}, and must match it if given.
   */
  sampleRate?: number;
  /** A language code such as `'de'`, or several the audio may be in. */
  language?: string | string[];
  /** The speech-to-text model ID, sent as given. Omit it for the default. */
  model?: string;
  /** Who ends a turn: `'kugelturn'` (default), `'vad'` or `'manual'`. */
  turnDetection?: 'kugelturn' | 'vad' | 'manual';
  /** How readily KugelTurn ends a turn; only with `turnDetection: 'kugelturn'`. */
  turnDetectionLevel?: 'responsive' | 'conservative';
  /** Names, brands and domain terms to spell as written. */
  boostedPhrases?: string[];
  /** The project whose dictionaries apply. Omit it to use the API key's project. */
  projectId?: number;
  /**
   * The project dictionaries whose words are applied after
   * {@link boostedPhrases}. Omit it to apply every active dictionary; `[]`
   * applies none.
   */
  dictionaryIds?: number[];
}

// ------------------------------------------------------------ validation

function streamRate(audio: unknown, sampleRate: number | undefined): number {
  if (audio instanceof AudioStream) {
    if (sampleRate !== undefined && sampleRate !== audio.sampleRate) {
      throw new ValidationError(
        `sampleRate ${sampleRate} does not match the audio's ${audio.sampleRate} Hz; ` +
          'omit sampleRate to use it.',
      );
    }
    return audio.sampleRate;
  }
  if (
    typeof audio === 'string' ||
    isBinary(audio) ||
    (typeof Blob !== 'undefined' && audio instanceof Blob) ||
    audio instanceof LoadedAudio
  ) {
    throw new ValidationError(
      'To transcribe a WAV file live, pass await loadAudioStream(...); to upload it, ' +
        'use client.asr.transcribe. Raw PCM16 goes in as an iterable or async iterable ' +
        'of chunks with sampleRate.',
    );
  }
  const iterable =
    audio != null &&
    (typeof (audio as any)[Symbol.iterator] === 'function' ||
      typeof (audio as any)[Symbol.asyncIterator] === 'function');
  if (!iterable) {
    throw new ValidationError(
      'Speech-to-text stream audio must be an AudioStream or an iterable of PCM16 chunks.',
    );
  }
  if (sampleRate === undefined) {
    throw new ValidationError('sampleRate is required when streaming raw PCM16 chunks.');
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new ValidationError(`sampleRate must be a positive integer in Hz, got ${sampleRate}.`);
  }
  return sampleRate;
}

/** The `config` frame: the sample rate plus only the options the caller set. */
function streamConfig(audio: unknown, options: TranscriptionStreamOptions): StreamingTranscriptionConfig {
  const config: StreamingTranscriptionConfig = {
    type: 'config',
    sample_rate: streamRate(audio, options.sampleRate),
  };
  if (options.model !== undefined) config.model = options.model;
  if (options.language !== undefined) config.language = options.language;
  if (options.turnDetection !== undefined) config.turn_detection = options.turnDetection;
  if (options.turnDetectionLevel !== undefined) config.turn_detection_level = options.turnDetectionLevel;
  if (options.boostedPhrases !== undefined) config.boosted_phrases = options.boostedPhrases;
  if (options.projectId !== undefined) config.project_id = options.projectId;
  if (options.dictionaryIds !== undefined) config.dictionary_ids = options.dictionaryIds;
  return config;
}

/** Validate one input chunk and split it into pieces of at most `maxBytes`. */
function* split(chunk: unknown, maxBytes: number): Generator<Uint8Array> {
  if (!isBinary(chunk)) {
    throw new ValidationError(
      `Speech-to-text stream chunks must be mono PCM16 bytes (Uint8Array or ArrayBuffer), got ${typeof chunk}.`,
    );
  }
  const data =
    chunk instanceof ArrayBuffer
      ? new Uint8Array(chunk)
      : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (let start = 0; start < data.length; start += maxBytes) {
    yield data.subarray(start, start + maxBytes);
  }
}

// ----------------------------------------------------------- WebSocket

/** Open `url`; a refused upgrade or early close rejects with its typed error. */
async function connect(url: string, timeoutMs: number, events: EventQueue): Promise<WebSocket> {
  const WS = getWebSocket() ?? (await loadWebSocket());
  let ws: WebSocket;
  try {
    ws = new WS(url);
  } catch {
    // Its message holds the URL, whose query carries the API key.
    throw new ValidationError('The KugelAudio API URL does not form a valid WebSocket URL.');
  }
  captureHandshakeRejection(ws);
  ws.onmessage = (event: { data: unknown }) => events.push({ kind: 'message', data: event.data });
  try {
    await openSocket(ws, timeoutMs);
  } catch (error) {
    close(ws);
    throw error;
  }
  ws.onclose = (event: { code?: number; reason?: string }) =>
    events.push({ kind: 'close', code: event.code, reason: event.reason });
  ws.onerror = () => {}; // the close event that follows carries the reason
  return ws;
}

function close(ws: WebSocket): void {
  try {
    ws.close();
  } catch {
    // KEEP-JUSTIFIED: the socket is already closed; nothing is left to report.
  }
}

/** Send every chunk as base64 `audio_chunk` frames of at most 1 s, then `end_of_speech`. */
async function sendAudio(
  ws: WebSocket,
  audio: Iterable<unknown> | AsyncIterable<unknown>,
  maxBytes: number,
  stopped: () => boolean,
): Promise<void> {
  const live = () => !stopped() && ws.readyState === WS_OPEN;
  for await (const chunk of audio) {
    for (const piece of split(chunk, maxBytes)) {
      if (!live()) return;
      const audio_b64 = arrayBufferToBase64(piece.slice().buffer as ArrayBuffer);
      ws.send(JSON.stringify({ type: 'audio_chunk', audio_b64 }));
      while (live() && ws.bufferedAmount > SEND_HIGH_WATER_BYTES) await sleep(5);
    }
  }
  if (live()) ws.send(END_OF_SPEECH);
}

async function* runStream(
  url: string,
  config: StreamingTranscriptionConfig,
  audio: Iterable<unknown> | AsyncIterable<unknown>,
  timeoutMs: number,
): AsyncGenerator<StreamingTranscriptionResult, void, undefined> {
  const events = new EventQueue();
  const ws = await connect(url, timeoutMs, events);
  let stopped = false;
  try {
    ws.send(JSON.stringify(config));
    sendAudio(ws, audio, config.sample_rate * 2, () => stopped).catch((error) => {
      events.push({ kind: 'failure', error });
      close(ws);
    });
    for (;;) {
      const event = await events.next();
      if (event.kind === 'failure') throw event.error;
      if (event.kind === 'close') {
        // The server closes with 1000 after the last turn following end_of_speech.
        if (event.code === WS_NORMAL_CLOSE) return;
        throw classifyWsClose(event.code, event.reason);
      }
      const message = parseText(event.data);
      if ('error' in message) throw classifyWsFrame(message as Parameters<typeof classifyWsFrame>[0]);
      if (message.type === 'partial' || message.type === 'alternatives') {
        yield message as StreamingTranscriptionResult;
      }
    }
  } finally {
    stopped = true;
    close(ws);
  }
}

// -------------------------------------------------------------- resource

/** Speech to text through the public KugelAudio API. */
export class ASRResource {
  constructor(private client: KugelAudio) {}

  /** Transcribe a recording uploaded as one file. */
  async transcribe(options: TranscribeOptions): Promise<TranscriptionResponse> {
    const form = new FormData();
    form.append('file', options.audio, options.filename ?? 'audio.wav');
    if (options.model !== undefined) form.append('model', options.model);
    if (options.language) form.append('language', options.language);
    for (const phrase of options.boostedPhrases ?? []) {
      form.append('boosted_phrases', phrase);
    }
    if (options.projectId !== undefined) form.append('project_id', String(options.projectId));
    if (options.dictionaryIds !== undefined) {
      // Repeated form fields cannot carry an empty list: one empty
      // `dictionary_ids` field is the multipart spelling of `[]`.
      const values = options.dictionaryIds.length > 0 ? options.dictionaryIds.map(String) : [''];
      for (const value of values) form.append('dictionary_ids', value);
    }
    return this.client.requestMultipart<TranscriptionResponse>('POST', TRANSCRIBE_PATH, form);
  }

  /**
   * Transcribe live audio; iterate the transcript frames as they arrive.
   *
   * Audio is sent in the background while you iterate, followed by
   * `end_of_speech`; iteration ends when the server closes the connection
   * after the last turn. Breaking out of the loop closes the connection and
   * stops sending. Server errors, abnormal closes and refused connections
   * throw the typed errors from `./errors`.
   *
   * @param audio An {@link AudioStream} from `loadAudioStream`, or any
   *   iterable / async iterable of raw mono PCM16 chunks together with
   *   `sampleRate` (chunks over 1 s are split).
   * @param options Optional settings; only the ones you set are sent.
   * @returns Partial, final and alternatives frames. A frame with
   *   `revises_final: true` carries a more accurate transcript of the whole
   *   turn and its `language`.
   * @example
   * ```typescript
   * const audio = await loadAudioStream('call.wav');
   * for await (const event of client.asr.stream(audio, { language: 'de' })) {
   *   if (event.is_final) console.log(event.partial_text);
   * }
   * ```
   */
  stream(
    audio: AudioStream | Iterable<PcmChunk> | AsyncIterable<PcmChunk>,
    options: TranscriptionStreamOptions = {},
  ): AsyncGenerator<StreamingTranscriptionResult, void, undefined> {
    const config = streamConfig(audio, options);
    const url = this.client.apiWsUrl(STREAM_PATH, { api_key: this.client.apiKey });
    return runStream(url, config, audio, this.client.timeout);
  }
}
