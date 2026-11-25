/**
 * Concurrent `tts.stream()` calls on one client share the pooled `/ws/tts`
 * socket. Its frames carry no request id: the server answers pipelined
 * requests strictly in order (`ingress.routes.ws_inbox.Inbox`), so each
 * frame belongs to the oldest request that has not yet seen its terminal
 * frame. These tests hold the SDK to that: every caller gets only its own
 * audio, including when a caller's own callback throws (ENG-3312).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KugelAudio } from './client';
import type { StreamCallbacks } from './types';

interface ServerSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
  send: (data: string) => void;
  close: () => void;
  /** The server drops the connection mid-turn (code 1006). */
  drop: () => void;
}

const sockets: ServerSocket[] = [];
/** Per request text: reply with a non-fatal error frame instead of audio. */
const failTexts = new Set<string>();

/**
 * Mock `/ws/tts`: one turn at a time per socket, later requests queued in
 * arrival order, each turn = 3 audio frames filled with the text's first
 * byte, then `final` (or one error frame for texts in `failTexts`).
 */
vi.mock('./websocket', () => ({
  getWebSocket: () =>
    class FifoTtsSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason?: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      private queue: string[] = [];
      private busy = false;

      constructor() {
        sockets.push(this as unknown as ServerSocket);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        }, 0);
      }

      send(data: string): void {
        this.queue.push(JSON.parse(data).text as string);
        void this.drain();
      }

      close(): void {
        this.shut(1000);
      }

      drop(): void {
        this.shut(1006);
      }

      private shut(code: number): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.queue.length = 0;
        setTimeout(() => this.onclose?.({ code }), 0);
      }

      private async drain(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        while (this.queue.length) {
          const text = this.queue.shift() as string;
          await tick();
          if (failTexts.has(text)) {
            this.emit({ error: 'synthesis failed', error_code: 'INTERNAL_ERROR' });
            continue;
          }
          for (let idx = 0; idx < 3; idx++) {
            const pcm = Buffer.alloc(8, text.charCodeAt(0));
            this.emit({ audio: pcm.toString('base64'), enc: 'pcm_s16le', idx, sr: 24000, samples: 4 });
            await tick();
          }
          this.emit({ final: true, chunks: 3, total_samples: 12, dur_ms: 1, gen_ms: 1, rtf: 1 });
        }
        this.busy = false;
      }

      private emit(frame: Record<string, unknown>): void {
        if (this.readyState !== 1) return;
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    },
}));

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

/** Collect the fill bytes of every chunk a caller receives. */
function recorder(): { bytes: Set<number>; callbacks: StreamCallbacks } {
  const bytes = new Set<number>();
  return {
    bytes,
    callbacks: {
      onChunk: (chunk) => {
        for (const b of Buffer.from(chunk.audio, 'base64')) bytes.add(b);
      },
    },
  };
}

const A = 'A'.charCodeAt(0);
const B = 'B'.charCodeAt(0);
const C = 'C'.charCodeAt(0);

describe('pooled /ws/tts: concurrent streams on one client (ENG-3312)', () => {
  let client: KugelAudio;

  beforeEach(() => {
    sockets.length = 0;
    failTexts.clear();
    client = new KugelAudio({ apiKey: 'test-key-xxx' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('delivers each caller only its own audio over the shared socket', async () => {
    const a = recorder();
    const b = recorder();
    const c = recorder();
    await Promise.all([
      client.tts.stream({ text: 'A', language: 'en' }, a.callbacks),
      client.tts.stream({ text: 'B', language: 'en' }, b.callbacks),
      client.tts.stream({ text: 'C', language: 'en' }, c.callbacks),
    ]);
    expect(sockets).toHaveLength(1);
    expect([...a.bytes]).toEqual([A]);
    expect([...b.bytes]).toEqual([B]);
    expect([...c.bytes]).toEqual([C]);
  });

  it('keeps the next caller audio out of a caller whose onFinal throws', async () => {
    const a = recorder();
    const b = recorder();
    a.callbacks.onFinal = () => {
      throw new Error('caller A torn down');
    };
    const streamA = client.tts.stream({ text: 'A', language: 'en' }, a.callbacks);
    const streamB = client.tts.stream({ text: 'B', language: 'en' }, b.callbacks);
    await Promise.race([
      Promise.allSettled([streamA, streamB]),
      new Promise((r) => setTimeout(r, 200)),
    ]);
    expect([...a.bytes]).toEqual([A]);
    expect([...b.bytes]).toEqual([B]);
    await expect(streamB).resolves.toBeUndefined();
  });

  it('keeps the next caller audio out of a caller whose onError throws', async () => {
    failTexts.add('A');
    const a = recorder();
    const b = recorder();
    a.callbacks.onError = () => {
      throw new Error('caller A torn down');
    };
    const streamA = client.tts.stream({ text: 'A', language: 'en' }, a.callbacks);
    const streamB = client.tts.stream({ text: 'B', language: 'en' }, b.callbacks);
    await Promise.race([
      Promise.allSettled([streamA, streamB]),
      new Promise((r) => setTimeout(r, 200)),
    ]);
    expect([...a.bytes]).toEqual([]);
    expect([...b.bytes]).toEqual([B]);
    await expect(streamA).rejects.toThrow();
    await expect(streamB).resolves.toBeUndefined();
  });

  it('keeps the next caller audio out of a caller whose onChunk throws', async () => {
    const a = recorder();
    const b = recorder();
    const record = a.callbacks.onChunk!;
    a.callbacks.onChunk = (chunk) => {
      record(chunk);
      throw new Error('caller A sink closed');
    };
    await Promise.all([
      client.tts.stream({ text: 'A', language: 'en' }, a.callbacks),
      client.tts.stream({ text: 'B', language: 'en' }, b.callbacks),
    ]);
    expect([...a.bytes]).toEqual([A]);
    expect([...b.bytes]).toEqual([B]);
  });
  it('keeps a swapped-out socket\'s request off the new socket\'s audio', async () => {
    const a = recorder();
    const b = recorder();
    const streamA = client.tts.stream({ text: 'A', language: 'en' }, a.callbacks);
    await tick();
    // The pooled URL changes (another org): the next request swaps sockets
    // while A is still in flight on the first one.
    (client as unknown as { _orgId: number })._orgId = 2;
    const streamB = client.tts.stream({ text: 'B', language: 'en' }, b.callbacks);
    await Promise.race([
      Promise.allSettled([streamA, streamB]),
      new Promise((r) => setTimeout(r, 200)),
    ]);
    expect(sockets).toHaveLength(2);
    expect([...a.bytes].filter((x) => x !== A)).toEqual([]);
    expect([...b.bytes]).toEqual([B]);
    await expect(streamB).resolves.toBeUndefined();
    await expect(streamA).rejects.toThrow();
  });

  it('rejects every request on a dropped socket even when one onClose throws', async () => {
    const a = recorder();
    const b = recorder();
    a.callbacks.onClose = () => {
      throw new Error('caller A torn down');
    };
    const streamA = client.tts.stream({ text: 'A', language: 'en' }, a.callbacks);
    const streamB = client.tts.stream({ text: 'B', language: 'en' }, b.callbacks);
    await tick();
    sockets[0].drop();
    const settled = await Promise.race([
      Promise.allSettled([streamA, streamB]),
      new Promise<null>((r) => setTimeout(() => r(null), 200)),
    ]);
    expect(settled).not.toBeNull();
    await expect(streamB).rejects.toThrow();

    // The next request runs on a fresh socket and hears only itself.
    const c = recorder();
    await client.tts.stream({ text: 'C', language: 'en' }, c.callbacks);
    expect([...c.bytes]).toEqual([C]);
    expect([...a.bytes, ...b.bytes].filter((x) => x === C)).toEqual([]);
  });
});
