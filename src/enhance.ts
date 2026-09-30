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
  RateLimitError,
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

/** One open enhancement socket and the events it delivered. */
interface Socket {
  ws: WebSocket;
  events: EventQueue;
  closed: boolean;
}

/** A reused session socket turned out closed before it took the config. */
class StaleSocket extends Error {}

// The server closes a session after 60 s without a config and at 1 h; a socket
// is not reused past these, a little before the server's limits.
const SESSION_IDLE_MS = 55_000;
const SESSION_LIFETIME_MS = 3_540_000;
// What a server without session mode sends on a socket left without a config
// for 30 s, before it closes it: that socket is stale, not the new config wrong.
const IDLE_FRAME_CODE = 408;

async function connectSocket(url: string, timeoutMs: number): Promise<Socket> {
  const WS = getWebSocket() ?? (await loadWebSocket());
  let ws: WebSocket;
  try {
    ws = new WS(url);
  } catch {
    // Its message holds the URL, whose query carries the API key.
    throw new ValidationError('The KugelAudio API URL does not form a valid WebSocket URL.');
  }
  captureHandshakeRejection(ws);
  ws.binaryType = 'arraybuffer';
  const socket: Socket = { ws, events: new EventQueue(), closed: false };
  ws.onmessage = (event: { data: unknown }) => socket.events.push({ kind: 'message', data: event.data });
  try {
    await openSocket(ws, timeoutMs);
  } catch (error) {
    try {
      ws.close();
    } catch {
      // already closed
    }
    throw error;
  }
  ws.onclose = (event: { code?: number; reason?: string }) => {
    socket.closed = true;
    socket.events.push({ kind: 'close', code: event.code, reason: event.reason });
  };
  ws.onerror = () => {}; // the close event that follows carries the reason
  return socket;
}

function closeSocket(socket: Socket): void {
  socket.closed = true;
  try {
    socket.ws.close();
  } catch {
    // already closed
  }
}

/**
 * Send `config` and wait for `ready`; returns it. On a `reused` socket, a
 * close (the server's idle, lifetime or restart close) or an old server's
 * idle-timeout frame throws {@link StaleSocket}.
 */
async function begin(
  socket: Socket,
  config: Record<string, unknown>,
  timeoutMs: number,
  reused: boolean,
): Promise<Record<string, unknown>> {
  if (socket.closed || socket.ws.readyState !== WS_OPEN) {
    if (reused) throw new StaleSocket();
    throw new ConnectionError('The enhancement connection is closed.');
  }
  socket.ws.send(JSON.stringify(config));
  const first = await socket.events.next(timeoutMs);
  if (first.kind === 'close') {
    if (reused) throw new StaleSocket();
    throw classifyWsClose(first.code, first.reason);
  }
  const ready = first.kind === 'message' ? parseText(first.data) : {};
  if (ready.type === 'error') {
    if (reused && ready.code === IDLE_FRAME_CODE) throw new StaleSocket();
    throw frameError(ready);
  }
  if (ready.type !== 'ready') {
    throw new ConnectionError('Unexpected first message from the enhancement stream.');
  }
  return ready;
}

/** After `ready`: send the audio and `end`, yield the enhanced chunks until `done`. Leaves the socket open. */
async function* exchange(
  socket: Socket,
  config: Record<string, unknown>,
  audio: Iterable<unknown> | AsyncIterable<unknown>,
): AsyncGenerator<Uint8Array, void, undefined> {
  let stopped = false;
  try {
    pump(socket.ws, audio, (config.sample_rate_hz as number) * 2, () => stopped).catch((error) => {
      socket.events.push({ kind: 'failure', error });
      closeSocket(socket);
    });
    for (;;) {
      const event = await socket.events.next();
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
  }
}

async function withSpeaker(
  config: Record<string, unknown>,
  speaker: AudioInput | undefined,
): Promise<Record<string, unknown>> {
  if (speaker === undefined) return config;
  const bytes = await readAudioBytes(speaker);
  return { ...config, speaker_wav_b64: arrayBufferToBase64(toBytes(bytes).buffer as ArrayBuffer) };
}

async function* runStream(
  url: string,
  config: Record<string, unknown>,
  audio: Iterable<unknown> | AsyncIterable<unknown>,
  speaker: AudioInput | undefined,
  timeoutMs: number,
): AsyncGenerator<Uint8Array, void, undefined> {
  const full = await withSpeaker(config, speaker);
  const socket = await connectSocket(url, timeoutMs);
  try {
    await begin(socket, full, timeoutMs, false);
    yield* exchange(socket, full, audio);
  } finally {
    closeSocket(socket);
  }
}

/** Serialises the streams of one session: the next waits for the previous. */
class Lock {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
}

/**
 * One warm WebSocket that carries enhancement streams one after another.
 *
 * From `client.enhance.session()`. Call {@link EnhanceSession.connect} ahead of
 * the first audio (e.g. while an agent starts) and {@link EnhanceSession.close}
 * when done. Each {@link EnhanceSession.stream} sends its own config, so the
 * task, speaker and sample rate may change between streams; it is admitted and
 * billed as one request of its own. Streams run one at a time: a second
 * `stream()` waits until the first has finished.
 *
 * The socket is replaced without an error when the server closed it (after
 * 60 s without a stream, at its one-hour lifetime, or during a restart). A
 * server without session support gets one connection per stream instead.
 *
 * @example
 * ```typescript
 * const session = client.enhance.session();
 * await session.connect();
 * try {
 *   for (const input of [first, second]) {
 *     for await (const chunk of session.stream(input, { model: 'clarity-1' })) play(chunk);
 *   }
 * } finally {
 *   await session.close();
 * }
 * ```
 */
export class EnhanceSession {
  private socket: Socket | null = null;
  private openedAt = 0;
  private idleSince = 0;
  private oneShot = false;
  private closed = false;
  /** A connect in flight, settled either way; `close()` waits for it. */
  private connecting: Promise<unknown> | null = null;
  private readonly lock = new Lock();

  constructor(private readonly client: KugelAudio) {}

  /**
   * Open the session's socket now, so the next `stream()` skips the
   * connection setup. Does nothing while an open socket is reusable. Rejects
   * with the typed handshake errors of `client.enhance.stream`.
   */
  async connect(): Promise<void> {
    const release = await this.lock.acquire();
    try {
      await this.acquireSocket();
    } finally {
      release();
    }
  }

  /**
   * Enhance one audio on the session's socket; same arguments and output as
   * `client.enhance.stream`. Stopping the iteration early ends this audio and
   * closes the socket (the next stream opens a new one).
   */
  stream(
    audio: AudioStream | Iterable<PcmChunk> | AsyncIterable<PcmChunk>,
    options: EnhanceStreamOptions,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const config = streamConfig(audio, options);
    return this.run(config, audio, options.speaker);
  }

  /**
   * Close the socket; the session cannot stream afterwards. A connect still
   * in flight is waited for and its socket closed too.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.connecting;
    this.drop();
  }

  private async *run(
    config: Record<string, unknown>,
    audio: Iterable<unknown> | AsyncIterable<unknown>,
    speaker: AudioInput | undefined,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const timeoutMs = this.client.timeout;
    const full = await withSpeaker(config, speaker);
    const release = await this.lock.acquire();
    try {
      let [socket, reused] = await this.acquireSocket();
      if (socket === null) {
        yield* runStream(this.url(false), full, audio, undefined, timeoutMs);
        return;
      }
      let ready: Record<string, unknown>;
      try {
        try {
          ready = await begin(socket, full, timeoutMs, reused);
        } catch (error) {
          if (!(error instanceof StaleSocket)) throw error;
          this.drop();
          [socket] = await this.acquireSocket();
          if (socket === null) {
            throw new ConnectionError('The enhancement session could not be reopened.');
          }
          ready = await begin(socket, full, timeoutMs, false);
        }
      } catch (error) {
        // A rate-limit refusal of the config leaves the socket open; after
        // anything else the server's state for this socket is unknown.
        if (!(error instanceof RateLimitError) || socket.closed) this.drop();
        throw error;
      }
      if (!('request_id' in ready)) {
        // The server ignored session=1: it closes after this audio.
        this.oneShot = true;
      }
      let finished = false;
      try {
        yield* exchange(socket, full, audio);
        finished = true;
      } finally {
        if (finished && !this.oneShot) this.idleSince = Date.now();
        else this.drop();
      }
    } finally {
      release();
    }
  }

  /** The session socket and whether it was already open, opening one when needed; `[null, false]` when this stream must connect on its own. */
  private async acquireSocket(): Promise<[Socket | null, boolean]> {
    if (this.closed) throw new KugelAudioError('The enhancement session is closed.');
    if (this.oneShot) return [null, false];
    if (this.socket !== null && this.reusable(this.socket)) return [this.socket, true];
    this.drop();
    let socket: Socket;
    const pending = connectSocket(this.url(true), this.client.timeout);
    this.connecting = pending.catch(() => undefined);
    try {
      socket = await pending;
    } catch (error) {
      if (this.closed) throw new KugelAudioError('The enhancement session is closed.');
      // The open-session limit (429 without Retry-After) or a server that
      // does not know sessions (400): stream on a connection of its own.
      const sessionCap = error instanceof RateLimitError && error.retryAfter === undefined;
      if (!sessionCap && !(error instanceof ValidationError)) throw error;
      if (error instanceof ValidationError) this.oneShot = true;
      return [null, false];
    } finally {
      this.connecting = null;
    }
    if (this.closed) {
      // close() ran while this socket was connecting.
      closeSocket(socket);
      throw new KugelAudioError('The enhancement session is closed.');
    }
    this.socket = socket;
    this.openedAt = this.idleSince = Date.now();
    return [socket, false];
  }

  private reusable(socket: Socket): boolean {
    const now = Date.now();
    return (
      !socket.closed &&
      socket.ws.readyState === WS_OPEN &&
      now - this.idleSince < SESSION_IDLE_MS &&
      now - this.openedAt < SESSION_LIFETIME_MS
    );
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) closeSocket(socket);
  }

  private url(session: boolean): string {
    const query: Record<string, string> = { api_key: this.client.apiKey };
    if (session) query.session = '1';
    return this.client.apiWsUrl(ENHANCE_STREAM_PATH, query);
  }
}

/** Validate the stream input and build its config (the speaker is added when sending). */
function streamConfig(audio: unknown, options: EnhanceStreamOptions): Record<string, unknown> {
  checkModel(options?.model);
  const rate = streamRate(audio, options.sampleRate);
  const config: Record<string, unknown> = {
    type: 'config',
    model: options.model,
    task: TASK_NOISE_REMOVAL,
    sample_rate_hz: rate,
    encoding: 'pcm_s16le',
  };
  if (options.speaker !== undefined) {
    checkAudio(options.speaker, 'speaker');
    config.task = TASK_TARGET_SPEAKER_EXTRACTION;
  }
  return config;
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
   * Open the connection `generate` uses, so the first request skips the
   * connection setup (TCP and TLS).
   *
   * Sends one `GET` to the enhancement path, which only accepts `POST`: the
   * server refuses it before authentication or any processing, so it is not
   * billed and does not count against rate limits. Safe to call any number of
   * times; call it shortly before the first request, since idle connections
   * are closed after a few seconds. Never rejects: a network error is logged
   * and the first request then connects as usual.
   *
   * @example
   * ```typescript
   * await client.enhance.prewarm();
   * const result = await client.enhance.generate(await loadAudio('call.wav'), { model: 'clarity-1' });
   * ```
   */
  async prewarm(): Promise<void> {
    await this.client.warmConnection(ENHANCE_PATH);
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
    const config = streamConfig(audio, options);
    const url = this.client.apiWsUrl(ENHANCE_STREAM_PATH, { api_key: this.client.apiKey });
    return runStream(url, config, audio, options.speaker, this.client.timeout);
  }

  /**
   * A session: one warm WebSocket for many `stream`-style calls.
   *
   * Opening a connection costs a TCP, TLS and WebSocket handshake plus the
   * server's admission; a session pays that once, and `connect()` pays it
   * before the first audio. Each stream on it is still one request (rate
   * limits, billing). Close it when done.
   *
   * @example
   * ```typescript
   * const session = client.enhance.session();
   * await session.connect();
   * for await (const chunk of session.stream(input, { model: 'clarity-1' })) play(chunk);
   * await session.close();
   * ```
   */
  session(): EnhanceSession {
    return new EnhanceSession(this.client);
  }
}
