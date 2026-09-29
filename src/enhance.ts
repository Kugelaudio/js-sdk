/**
 * Speech enhancement: remove background noise, or keep only one voice.
 *
 * Exposed as `client.enhance`. One rule everywhere: enhancement removes
 * noise; passing `speaker` keeps only that voice.
 *
 * @example
 * ```typescript
 * const audio = await loadAudio('meeting.wav');
 * const speaker = await loadAudio('speaker.wav');
 * const result = await client.enhance.generate(audio, { model: 'clarity-1', speaker });
 * await result.save('clean.wav');
 * ```
 */

import { AudioStream, LoadedAudio, isBinary, nodeFs, parseWav, toBytes } from './audio';
import type { KugelAudio } from './client';
import {
  ConnectionError,
  KugelAudioError,
  ValidationError,
  classifyWsClose,
  classifyWsFrame,
  classifyWsHandshakeError,
} from './errors';
import { captureHandshakeRejection, handshakeDeadline, handshakeRejectionOf } from './handshake';
import { arrayBufferToBase64, createWavFile } from './utils';
import { getWebSocket, loadWebSocket } from './websocket';

export const TASK_NOISE_REMOVAL = 'noise_removal';
export const TASK_TARGET_SPEAKER_EXTRACTION = 'target_speaker_extraction';
/** Sample rate of every enhancement result, in Hz. */
export const ENHANCED_SAMPLE_RATE = 24000;

const ENHANCE_PATH = '/v1/audio/enhance';
const ENHANCE_STREAM_PATH = '/v1/audio/enhance/stream';
const END_MESSAGE = JSON.stringify({ type: 'end' });
const NOT_READY = 'The enhancement stream did not become ready in time.';
const WS_OPEN = 1;
const SEND_HIGH_WATER_BYTES = 1 << 20;

/**
 * Audio accepted by `client.enhance`: the result of {@link loadAudio}, or the
 * WAV file itself as a `Blob` / `File`, `ArrayBuffer` or `Uint8Array`.
 * Methods never take file paths; load files with `loadAudio`.
 */
export type AudioInput = LoadedAudio | Blob | ArrayBuffer | ArrayBufferView;

/** A raw mono PCM16 chunk passed to `client.enhance.stream`. */
export type PcmChunk = ArrayBuffer | ArrayBufferView;

/** Options for `client.enhance.generate`. */
export interface EnhanceGenerateOptions {
  /** Enhancement model, e.g. `'clarity-1'`. Required. */
  model: string;
  /**
   * Optional clean 2-8 s sample of one voice. When given, only that voice is
   * kept and every other sound removed.
   */
  speaker?: AudioInput;
}

/** Options for `client.enhance.stream`. */
export interface EnhanceStreamOptions extends EnhanceGenerateOptions {
  /**
   * Sample rate of raw PCM16 chunks (8-48 kHz). Required for raw chunks;
   * taken from an {@link AudioStream}, and must match it if given.
   */
  sampleRate?: number;
}

/** Enhanced audio: mono PCM16 at 24 kHz, same duration as the input. */
export class EnhancedAudio {
  constructor(
    /** Raw mono PCM16 (little-endian) samples. */
    readonly audio: Uint8Array,
    readonly sampleRate: number = ENHANCED_SAMPLE_RATE,
  ) {}

  /** Parse a mono PCM16 WAV file into an `EnhancedAudio`. */
  static fromWav(bytes: Uint8Array): EnhancedAudio {
    const wav = parseWav(bytes);
    if (!wav) {
      throw new KugelAudioError('Unexpected enhancement response: not a WAV file.');
    }
    if (wav.channels !== 1 || wav.bitsPerSample !== 16 || wav.format !== 1) {
      throw new KugelAudioError('Unexpected enhancement response: expected mono PCM16 WAV.');
    }
    return new EnhancedAudio(wav.data.slice(), wav.sampleRate);
  }

  /** Duration in seconds. */
  get duration(): number {
    return Math.floor(this.audio.length / 2) / this.sampleRate;
  }

  /** The audio as WAV file bytes. */
  get wav(): Uint8Array {
    return new Uint8Array(createWavFile(toBytes(this.audio).buffer as ArrayBuffer, this.sampleRate));
  }

  /** The audio as a WAV `Blob`, e.g. for an `<audio>` element. */
  toBlob(): Blob {
    return new Blob([this.wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
  }

  /** Write the audio to `path` as a WAV file (Node.js only). */
  async save(path: string): Promise<void> {
    const fs = await nodeFs();
    await fs.writeFile(path, this.wav);
  }
}

// ------------------------------------------------------------ validation

function checkModel(model: unknown): asserts model is string {
  if (typeof model !== 'string' || !model.trim()) {
    throw new ValidationError("model must be a non-empty string, e.g. { model: 'clarity-1' }.");
  }
}

function checkAudio(value: unknown, name: string): asserts value is AudioInput {
  const ok =
    value instanceof LoadedAudio ||
    isBinary(value) ||
    (typeof Blob !== 'undefined' && value instanceof Blob);
  if (!ok) {
    const got = typeof value === 'string' ? 'a string' : typeof value;
    throw new TypeError(
      `${name} must be audio, got ${got}: pass await loadAudio(...), ` +
        `e.g. ${name}: await loadAudio('${name}.wav').`,
    );
  }
}

/** Blob + filename for a multipart part. */
function toPart(value: AudioInput): { blob: Blob; filename: string } {
  if (value instanceof LoadedAudio) {
    const data = value.data as Uint8Array<ArrayBuffer>;
    return { blob: new Blob([data], { type: 'audio/wav' }), filename: value.filename };
  }
  if (isBinary(value)) {
    const data = toBytes(value) as Uint8Array<ArrayBuffer>;
    return { blob: new Blob([data], { type: 'audio/wav' }), filename: 'audio.wav' };
  }
  const name = (value as { name?: unknown }).name;
  return { blob: value, filename: typeof name === 'string' && name ? name : 'audio.wav' };
}

async function readAudioBytes(value: AudioInput): Promise<Uint8Array> {
  if (value instanceof LoadedAudio) return value.data;
  if (isBinary(value)) return toBytes(value);
  return new Uint8Array(await value.arrayBuffer());
}

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
      'To stream a WAV file, pass await loadAudioStream(...). Raw PCM16 goes in ' +
        'as an iterable or async iterable of chunks with sampleRate.',
    );
  }
  const iterable =
    audio != null &&
    (typeof (audio as any)[Symbol.iterator] === 'function' ||
      typeof (audio as any)[Symbol.asyncIterator] === 'function');
  if (!iterable) {
    throw new ValidationError(
      'Enhancement stream audio must be an AudioStream or an iterable of PCM16 chunks.',
    );
  }
  if (sampleRate === undefined) {
    throw new ValidationError('sampleRate is required when streaming raw PCM16 chunks.');
  }
  return sampleRate;
}

/** Validate one input chunk and split it into messages of at most `maxBytes`. */
function* split(chunk: unknown, maxBytes: number): Generator<Uint8Array> {
  if (!isBinary(chunk)) {
    throw new ValidationError(
      `Enhancement stream chunks must be mono PCM16 bytes (Uint8Array or ArrayBuffer), got ${typeof chunk}.`,
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

/** A server error frame (`{type: 'error', error, error_code, code, ...}`), typed like TTS. */
function frameError(data: Record<string, unknown>): KugelAudioError {
  return classifyWsFrame(data as Parameters<typeof classifyWsFrame>[0]);
}

type StreamEvent =
  | { kind: 'message'; data: unknown }
  | { kind: 'close'; code?: number; reason?: string }
  | { kind: 'failure'; error: unknown };

/** Buffers socket events until the generator asks for the next one. */
class EventQueue {
  private items: StreamEvent[] = [];
  private waiter: ((event: StreamEvent) => void) | null = null;

  push(event: StreamEvent): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(event);
    } else {
      this.items.push(event);
    }
  }

  next(timeoutMs?: number): Promise<StreamEvent> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiter = null;
          reject(new ConnectionError(NOT_READY));
        }, timeoutMs);
      }
      this.waiter = (event) => {
        if (timer) clearTimeout(timer);
        resolve(event);
      };
    });
  }
}

function openSocket(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = handshakeDeadline(ws, timeoutMs, reject);
    ws.onopen = () => {
      if (deadline.opened()) resolve();
    };
    ws.onerror = (event: unknown) => {
      deadline.failed();
      // A refused upgrade: the kept rejection response, else the transport error.
      const failure =
        handshakeRejectionOf(ws) ?? (event as { error?: unknown } | null)?.error ?? event;
      reject(
        classifyWsHandshakeError(failure) ??
          new ConnectionError('KugelAudio WebSocket handshake failed.'),
      );
    };
    ws.onclose = (event: { code?: number; reason?: string }) => {
      deadline.failed();
      reject(classifyWsClose(event.code, event.reason));
    };
  });
}

/** Binary frame payload as bytes, or `null` for a text frame. */
async function binaryPayload(data: unknown): Promise<Uint8Array | null> {
  if (typeof data === 'string') return null;
  if (isBinary(data)) return toBytes(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return null;
}

function parseText(data: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(data));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send every input chunk, then `end`. Stops quietly once the socket closes. */
async function pump(
  ws: WebSocket,
  audio: Iterable<unknown> | AsyncIterable<unknown>,
  maxBytes: number,
  stopped: () => boolean,
): Promise<void> {
  const live = () => !stopped() && ws.readyState === WS_OPEN;
  for await (const chunk of audio) {
    for (const message of split(chunk, maxBytes)) {
      if (!live()) return;
      ws.send(message as Uint8Array<ArrayBuffer>);
      while (live() && ws.bufferedAmount > SEND_HIGH_WATER_BYTES) await sleep(5);
    }
  }
  if (live()) ws.send(END_MESSAGE);
}

async function* runStream(
  url: string,
  config: Record<string, unknown>,
  audio: Iterable<unknown> | AsyncIterable<unknown>,
  speaker: AudioInput | undefined,
  timeoutMs: number,
): AsyncGenerator<Uint8Array, void, undefined> {
  if (speaker !== undefined) {
    const bytes = await readAudioBytes(speaker);
    config.speaker_wav_b64 = arrayBufferToBase64(toBytes(bytes).buffer as ArrayBuffer);
  }
  const WS = getWebSocket() ?? (await loadWebSocket());
  const ws = new WS(url);
  captureHandshakeRejection(ws);
  ws.binaryType = 'arraybuffer';
  const events = new EventQueue();
  ws.onmessage = (event: { data: unknown }) => events.push({ kind: 'message', data: event.data });
  let stopped = false;
  try {
    await openSocket(ws, timeoutMs);
    ws.onclose = (event: { code?: number; reason?: string }) =>
      events.push({ kind: 'close', code: event.code, reason: event.reason });
    ws.onerror = () => {}; // the close event that follows carries the reason
    ws.send(JSON.stringify(config));

    const first = await events.next(timeoutMs);
    if (first.kind === 'close') throw classifyWsClose(first.code, first.reason);
    const ready = first.kind === 'message' ? parseText(first.data) : {};
    if (ready.type === 'error') throw frameError(ready);
    if (ready.type !== 'ready') {
      throw new ConnectionError('Unexpected first message from the enhancement stream.');
    }

    pump(ws, audio, (config.sample_rate_hz as number) * 2, () => stopped).catch((error) => {
      events.push({ kind: 'failure', error });
      ws.close();
    });

    for (;;) {
      const event = await events.next();
      if (event.kind === 'failure') throw event.error;
      if (event.kind === 'close') throw classifyWsClose(event.code, event.reason);
      const bytes = await binaryPayload(event.data);
      if (bytes) {
        yield bytes;
        continue;
      }
      const message = parseText(event.data);
      if (message.type === 'error') throw frameError(message);
      if (message.type === 'done') return;
    }
  } finally {
    stopped = true;
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}

// -------------------------------------------------------------- resource

/**
 * Speech enhancement through the public KugelAudio API.
 *
 * Enhancement removes background noise; passing `speaker` (a clean 2-8 s
 * sample of one voice) keeps only that voice. Results are mono PCM16 at
 * 24 kHz with the same duration as the input.
 */
export class EnhanceResource {
  constructor(private client: KugelAudio) {}

  /**
   * Enhance a recording: remove noise, or keep only `speaker`'s voice.
   *
   * @param audio The recording: `await loadAudio(...)`, or the WAV file as a
   *   Blob / ArrayBuffer / Uint8Array (PCM 16/24/32-bit or float, mono or
   *   stereo, 8-48 kHz, at most 300 s).
   * @param options `model` (required) and optional `speaker`.
   * @returns The enhanced audio (mono PCM16, 24 kHz, same duration).
   * @example
   * ```typescript
   * const result = await client.enhance.generate(await loadAudio('call.wav'), { model: 'clarity-1' });
   * await result.save('clean.wav');
   * ```
   */
  async generate(audio: AudioInput, options: EnhanceGenerateOptions): Promise<EnhancedAudio> {
    checkModel(options?.model);
    checkAudio(audio, 'audio');
    const { speaker } = options;
    if (speaker !== undefined) checkAudio(speaker, 'speaker');

    const form = new FormData();
    const file = toPart(audio);
    form.append('file', file.blob, file.filename);
    form.append('model', options.model);
    form.append('task', speaker !== undefined ? TASK_TARGET_SPEAKER_EXTRACTION : TASK_NOISE_REMOVAL);
    if (speaker !== undefined) {
      const part = toPart(speaker);
      form.append('speaker', part.blob, part.filename);
    }
    return this.client.requestMultipart('POST', ENHANCE_PATH, form, async (response) =>
      EnhancedAudio.fromWav(new Uint8Array(await response.arrayBuffer())),
    );
  }

  /**
   * Enhance audio in real time; iterate the enhanced chunks as they arrive.
   *
   * Input is sent in the background while you iterate, and iteration ends
   * once the last input has been enhanced. Breaking out of the loop closes
   * the connection and stops sending.
   *
   * @param audio An {@link AudioStream} from `loadAudioStream`, or any
   *   iterable / async iterable of raw mono PCM16 chunks (ideally at most
   *   1 s each; longer chunks are split) together with `sampleRate`.
   * @param options `model` (required), optional `speaker` and `sampleRate`.
   * @returns Enhanced mono PCM16 chunks at 24 kHz.
   * @example
   * ```typescript
   * const input = await loadAudioStream('meeting.wav');
   * for await (const chunk of client.enhance.stream(input, { model: 'clarity-1' })) {
   *   play(chunk);
   * }
   * ```
   */
  stream(
    audio: AudioStream | Iterable<PcmChunk> | AsyncIterable<PcmChunk>,
    options: EnhanceStreamOptions,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    checkModel(options?.model);
    const rate = streamRate(audio, options.sampleRate);
    const { speaker } = options;
    const config: Record<string, unknown> = {
      type: 'config',
      model: options.model,
      task: TASK_NOISE_REMOVAL,
      sample_rate_hz: rate,
      encoding: 'pcm_s16le',
    };
    if (speaker !== undefined) {
      checkAudio(speaker, 'speaker');
      config.task = TASK_TARGET_SPEAKER_EXTRACTION;
    }
    const url = this.client.apiWsUrl(ENHANCE_STREAM_PATH, { api_key: this.client.apiKey });
    return runStream(url, config, audio, speaker, this.client.timeout);
  }
}
