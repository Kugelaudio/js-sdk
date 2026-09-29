/**
 * Load WAV audio for speech enhancement.
 *
 * `loadAudio` loads a whole recording for `client.enhance.generate`;
 * `loadAudioStream` loads one as mono PCM16 chunks for `client.enhance.stream`.
 * File paths are read only in Node.js; in the browser pass a `Blob`,
 * `ArrayBuffer` or `Uint8Array`.
 */

import { KugelAudioError, ValidationError } from './errors';

/** A WAV file path (Node.js only) or the WAV file's bytes. */
export type AudioSource = string | Blob | ArrayBuffer | ArrayBufferView;

const FORMAT_HINT =
  'Use a 16-bit PCM WAV, or client.enhance.generate(await loadAudio(...)), ' +
  'which accepts any supported WAV.';

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** The parts of a WAV file the SDK needs. @internal */
export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Uint8Array;
}

/** Copy any binary input into a standalone `Uint8Array`. @internal */
export function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

/** Whether `value` is an `ArrayBuffer` or a typed-array / DataView. @internal */
export function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** Parse a RIFF/WAVE file; `null` when it is not one. @internal */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Omit<WavInfo, 'data'> | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      let format = view.getUint16(body, true);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 26 && body + 26 <= bytes.length) {
        format = view.getUint16(body + 24, true); // SubFormat GUID's first two bytes
      }
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) return null;
      const end = Math.min(bytes.length, body + size); // tolerate streamed/oversized sizes
      return { ...fmt, data: bytes.subarray(body, end) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

interface NodeFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

/**
 * `fs/promises`, resolved at call time so browser bundles never see a
 * static Node import. @internal
 */
export async function nodeFs(): Promise<NodeFs> {
  const proc = (globalThis as { process?: any }).process;
  if (!proc?.versions?.node) {
    throw new KugelAudioError(
      'Reading and writing files needs Node.js. In the browser, pass a Blob, ' +
        'ArrayBuffer or Uint8Array instead of a path.',
    );
  }
  const builtin = proc.getBuiltinModule?.('node:fs/promises');
  if (builtin) return builtin as NodeFs;
  // eslint-disable-next-line no-new-func
  const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<NodeFs>;
  return dynamicImport('node:fs/promises');
}

async function readSource(source: AudioSource): Promise<{ filename: string; data: Uint8Array }> {
  let filename = 'audio.wav';
  let data: Uint8Array;
  if (typeof source === 'string') {
    const fs = await nodeFs();
    try {
      data = new Uint8Array(await fs.readFile(source));
    } catch (e) {
      throw new ValidationError(`Cannot read audio file ${source}: ${(e as Error).message}`);
    }
    filename = source.split(/[\\/]/).pop() || filename;
  } else if (typeof Blob !== 'undefined' && source instanceof Blob) {
    data = new Uint8Array(await source.arrayBuffer());
    const name = (source as { name?: unknown }).name;
    if (typeof name === 'string' && name) filename = name;
  } else if (isBinary(source)) {
    data = toBytes(source);
  } else {
    throw new TypeError(
      `Audio source must be a WAV path, Blob, ArrayBuffer or Uint8Array, got ${typeof source}.`,
    );
  }
  if (data.length === 0) throw new ValidationError('Audio must not be empty.');
  return { filename, data };
}

/** A WAV recording loaded with {@link loadAudio}. */
export class LoadedAudio {
  constructor(
    /** The WAV file bytes, sent as-is. */
    readonly data: Uint8Array,
    /** File name sent with the upload. */
    readonly filename: string = 'audio.wav',
    /** Duration in seconds when the header is readable here, else `undefined`. */
    readonly duration?: number,
  ) {}
}

/**
 * Load a WAV file for `client.enhance.generate`.
 *
 * Any WAV the API supports is accepted (PCM 16/24/32-bit or float, mono or
 * stereo, 8-48 kHz, at most 300 s); the server decodes it.
 *
 * @param source WAV file path (Node.js) or the WAV file as Blob / ArrayBuffer / Uint8Array.
 * @example
 * ```typescript
 * const audio = await loadAudio('meeting.wav');
 * const result = await client.enhance.generate(audio, { model: 'clarity-1' });
 * ```
 */
export async function loadAudio(source: AudioSource): Promise<LoadedAudio> {
  const { filename, data } = await readSource(source);
  const wav = parseWav(data);
  let duration: number | undefined;
  if (wav && wav.sampleRate > 0 && wav.channels > 0 && wav.bitsPerSample > 0) {
    const frameBytes = wav.channels * Math.ceil(wav.bitsPerSample / 8);
    duration = Math.floor(wav.data.length / frameBytes) / wav.sampleRate;
  }
  return new LoadedAudio(data, filename, duration);
}

/** Average interleaved little-endian PCM16 channels into mono. */
function downmix(pcm: Uint8Array, channels: number): Uint8Array {
  const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = new Uint8Array(frames * 2);
  const dst = new DataView(out.buffer);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += src.getInt16((f * channels + c) * 2, true);
    dst.setInt16(f * 2, Math.floor(sum / channels), true);
  }
  return out;
}

/**
 * Mono PCM16 audio served in fixed-length chunks, as fast as they are read.
 *
 * Iterate it (sync or `for await`) for `Uint8Array` chunks; iterating again
 * starts from the beginning. Create one with {@link loadAudioStream}.
 */
export class AudioStream implements Iterable<Uint8Array>, AsyncIterable<Uint8Array> {
  private readonly chunkBytes: number;

  constructor(
    private readonly pcm: Uint8Array,
    /** Sample rate of the audio in Hz. */
    readonly sampleRate: number,
    chunkSeconds = 0.1,
  ) {
    this.chunkBytes = Math.max(1, Math.floor(sampleRate * chunkSeconds)) * 2;
  }

  /** Duration in seconds. */
  get duration(): number {
    return Math.floor(this.pcm.length / 2) / this.sampleRate;
  }

  *[Symbol.iterator](): Iterator<Uint8Array> {
    for (let start = 0; start < this.pcm.length; start += this.chunkBytes) {
      yield this.pcm.subarray(start, start + this.chunkBytes);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (const chunk of this) yield chunk;
  }
}

/** Options for {@link loadAudioStream}. */
export interface LoadAudioStreamOptions {
  /**
   * Length of each chunk in seconds, greater than 0 and at most 1 (default
   * 0.1). Chunks are not paced; small ones let enhanced audio start coming
   * back sooner.
   */
  chunkSeconds?: number;
}

/**
 * Load a 16-bit PCM WAV file for `client.enhance.stream`.
 *
 * Stereo (or multi-channel) audio is downmixed to mono. The sample rate is
 * read from the file.
 *
 * @example
 * ```typescript
 * const audio = await loadAudioStream('meeting.wav');
 * for await (const chunk of client.enhance.stream(audio, { model: 'clarity-1' })) {
 *   // enhanced mono PCM16 at 24 kHz
 * }
 * ```
 */
export async function loadAudioStream(
  source: AudioSource,
  options: LoadAudioStreamOptions = {},
): Promise<AudioStream> {
  const chunkSeconds = options.chunkSeconds ?? 0.1;
  if (!(chunkSeconds > 0 && chunkSeconds <= 1)) {
    throw new ValidationError('chunkSeconds must be greater than 0 and at most 1.');
  }
  const { data } = await readSource(source);
  const wav = parseWav(data);
  if (!wav || wav.channels < 1 || wav.sampleRate < 1) {
    throw new ValidationError(`Cannot read the WAV file. ${FORMAT_HINT}`);
  }
  if (wav.format !== WAVE_FORMAT_PCM || wav.bitsPerSample !== 16) {
    const kind = wav.format === WAVE_FORMAT_PCM ? `${wav.bitsPerSample}-bit` : 'not integer PCM';
    throw new ValidationError(`The WAV file is ${kind}. ${FORMAT_HINT}`);
  }
  let pcm = wav.data.subarray(0, wav.data.length - (wav.data.length % (2 * wav.channels)));
  if (pcm.length === 0) throw new ValidationError('Audio must not be empty.');
  pcm = wav.channels > 1 ? downmix(pcm, wav.channels) : pcm.slice();
  return new AudioStream(pcm, wav.sampleRate, chunkSeconds);
}
