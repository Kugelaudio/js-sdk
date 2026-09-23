import { AudioByteStream, type TimedString, type tts } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';

const NUM_CHANNELS = 1;

/**
 * Turns raw PCM byte chunks into LiveKit {@link AudioFrame}s, deferring the
 * last produced frame so it can be flagged `final` once the segment ends. Word
 * timings are attached to the next emitted frame. Mirrors the frame-emission
 * behaviour of the Python plugin's `AudioEmitter`.
 */
export class AudioSink {
  #bstream: AudioByteStream;
  #lastFrame: AudioFrame | undefined;
  #pendingTimed: TimedString[] = [];
  #ended = false;

  constructor(
    private readonly sampleRate: number,
    private readonly put: (audio: tts.SynthesizedAudio) => void,
    private readonly requestId: string,
    private readonly segmentId: string,
  ) {
    this.#bstream = new AudioByteStream(sampleRate, NUM_CHANNELS);
  }

  #emit(final: boolean): void {
    if (!this.#lastFrame) return;
    this.put({
      requestId: this.requestId,
      segmentId: this.segmentId,
      frame: this.#lastFrame,
      final,
      timedTranscripts: this.#pendingTimed.length > 0 ? this.#pendingTimed : undefined,
    });
    this.#lastFrame = undefined;
    this.#pendingTimed = [];
  }

  pushAudio(bytes: Buffer): void {
    if (this.#ended) return;
    for (const frame of this.#bstream.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)) {
      this.#emit(false);
      this.#lastFrame = frame;
    }
  }

  pushTimed(words: TimedString[]): void {
    if (this.#ended) return;
    this.#pendingTimed.push(...words);
  }

  /**
   * Emit all buffered audio now (non-final), including the deferred last
   * frame. Called on the server's `chunk_complete` — mirrors the Python
   * plugin's `emitter.flush()`. Without it the sub-frame tail of a sentence
   * sits here until the next sentence's bytes arrive, which plays out as a
   * gap/click at the sentence seam. `end()` still emits the terminal frame
   * (zero-length if no audio follows a flush).
   */
  flush(): void {
    if (this.#ended) return;
    for (const frame of this.#bstream.flush()) {
      // An empty byte stream flushes a zero-sample frame; carries no audio.
      if (frame.samplesPerChannel === 0) continue;
      this.#emit(false);
      this.#lastFrame = frame;
    }
    this.#emit(false);
  }

  /** Flush any buffered audio and emit the terminal (`final`) frame. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const frame of this.#bstream.flush()) {
      this.#emit(false);
      this.#lastFrame = frame;
    }
    // Since @livekit/agents 1.6.1, flushing an empty AudioByteStream yields no
    // frame (it used to yield a zero-sample one), so after a chunk_complete
    // flush there may be nothing left to carry the flag. The segment still
    // needs its terminal frame.
    this.#lastFrame ??= new AudioFrame(new Int16Array(0), this.sampleRate, NUM_CHANNELS, 0);
    this.#emit(true);
  }
}
