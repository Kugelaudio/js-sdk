/**
 * Unit tests for TTSResource.toReadable() and keepalive ping mechanism.
 *
 * These tests mock the WebSocket and verify that toReadable() correctly
 * pipes audio chunks into a Node.js Readable stream without gaps or
 * ordering issues — the root cause of KUG-157.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KugelAudio } from './client';
import { ConnectionError, RateLimitError, ServerRestartingError } from './errors';
import { parseSessionUsage } from './types';

// ---------------------------------------------------------------------------
// Minimal WebSocket mock
// ---------------------------------------------------------------------------

type WsListener = (event: { data: string }) => void;
type WsCloseListener = (event: { code: number; reason?: string }) => void;

interface MockWs {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: WsListener | null;
  onerror: (() => void) | null;
  onclose: WsCloseListener | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  ping?: ReturnType<typeof vi.fn>;
}

let mockWs: MockWs;

vi.mock('./websocket', () => ({
  getWebSocket: () => {
    return class MockWebSocket {
      url: string;
      readyState = 0; // CONNECTING
      onopen: (() => void) | null = null;
      onmessage: WsListener | null = null;
      onerror: (() => void) | null = null;
      onclose: WsCloseListener | null = null;
      send = vi.fn();
      close = vi.fn();
      ping = vi.fn();

      constructor(url: string) {
        this.url = url;
        mockWs = this as unknown as MockWs;
        // Simulate async open
        setTimeout(() => {
          this.readyState = 1; // OPEN
          this.onopen?.();
        }, 0);
      }
    };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAudioMsg(index: number, samples = 100): string {
  // Create a Buffer of `samples * 2` bytes (PCM16 = 2 bytes/sample) and base64-encode it.
  const pcm = Buffer.alloc(samples * 2, index); // fill with byte value = index
  return JSON.stringify({
    audio: pcm.toString('base64'),
    enc: 'pcm_s16le',
    idx: index,
    sr: 24000,
    samples,
  });
}

function makeFinalMsg(chunks: number, totalSamples: number): string {
  return JSON.stringify({
    final: true,
    chunks,
    total_samples: totalSamples,
    dur_ms: 100,
    gen_ms: 50,
    ttfa_ms: 30,
    rtf: 0.5,
  });
}

/** Collect all data events from a Readable into a single Buffer. */
function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => parts.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseSessionUsage (/ws/tts final + session_closed)', () => {
  it('parses the usage block from a /ws/tts final frame', () => {
    const usage = parseSessionUsage({
      final: true,
      chunks: 3,
      total_samples: 1000,
      dur_ms: 5400,
      gen_ms: 900,
      rtf: 0.17,
      usage: {
        audio_seconds: 5.4,
        characters: 142,
        cost_cents: 0.49,
        currency: 'eur',
        model_id: 'kugel-3',
      },
    });
    expect(usage).not.toBeNull();
    expect(usage?.audioSeconds).toBe(5.4);
    expect(usage?.costCents).toBe(0.49);
    expect(usage?.costAvailable).toBe(true);
  });

  it('reports cost null (not zero) when unavailable', () => {
    const usage = parseSessionUsage({
      final: true,
      usage: { audio_seconds: 2.0, cost_cents: null, cost_unavailable: true },
    });
    expect(usage?.costCents).toBeNull();
    expect(usage?.costAvailable).toBe(false);
  });

});

describe('TTSResource.generate() sampleRate', () => {
  function chunkAt(sr: number): string {
    const pcm = Buffer.alloc(20, 1);
    return JSON.stringify({ audio: pcm.toString('base64'), enc: 'pcm_s16le', idx: 0, sr, samples: 10 });
  }

  it('reports the rate of the audio received, not the 24 kHz default', async () => {
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });
    const pending = client.tts.generate({ text: 'Hi', outputFormat: 'pcm_16000' });
    await new Promise<void>((r) => setTimeout(r, 10));

    mockWs.onmessage?.({ data: chunkAt(16000) });
    mockWs.onmessage?.({ data: makeFinalMsg(1, 10) });

    expect((await pending).sampleRate).toBe(16000);
  });

  it('prefers the rate the server sent over the requested sampleRate', async () => {
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });
    const pending = client.tts.generate({ text: 'Hi', sampleRate: 24000 });
    await new Promise<void>((r) => setTimeout(r, 10));

    mockWs.onmessage?.({ data: chunkAt(22050) });
    mockWs.onmessage?.({ data: makeFinalMsg(1, 10) });

    expect((await pending).sampleRate).toBe(22050);
  });

  it('derives the rate from outputFormat when no audio arrived', async () => {
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });
    const pending = client.tts.generate({ text: 'Hi', outputFormat: 'ulaw_8000' });
    await new Promise<void>((r) => setTimeout(r, 10));

    mockWs.onmessage?.({ data: makeFinalMsg(0, 0) });

    expect((await pending).sampleRate).toBe(8000);
  });
});

describe('TTSResource.toReadable()', () => {
  let client: KugelAudio;

  beforeEach(() => {
    client = new KugelAudio({ apiKey: 'test-key-xxx' });
  });

  it('returns a Readable that emits raw PCM16 bytes for each audio chunk', async () => {
    const readable = client.tts.toReadable({ text: 'Hello' });

    // Wait for the mock WebSocket to open and send() to be called
    await new Promise<void>((r) => setTimeout(r, 10));

    // Simulate three audio chunks followed by final
    mockWs.onmessage?.({ data: makeAudioMsg(0, 100) });
    mockWs.onmessage?.({ data: makeAudioMsg(1, 200) });
    mockWs.onmessage?.({ data: makeAudioMsg(2, 150) });
    mockWs.onmessage?.({ data: makeFinalMsg(3, 450) });

    const result = await collectStream(readable);

    // Each PCM16 chunk is samples*2 bytes
    expect(result.byteLength).toBe((100 + 200 + 150) * 2);
  });

  it('emits chunks in the correct order', async () => {
    const readable = client.tts.toReadable({ text: 'Order test' });

    await new Promise<void>((r) => setTimeout(r, 10));

    // Use distinct fill patterns per chunk so ordering is detectable
    const chunk0 = Buffer.alloc(10, 0x01);
    const chunk1 = Buffer.alloc(10, 0x02);
    const chunk2 = Buffer.alloc(10, 0x03);

    mockWs.onmessage?.({ data: JSON.stringify({ audio: chunk0.toString('base64'), enc: 'pcm_s16le', idx: 0, sr: 24000, samples: 5 }) });
    mockWs.onmessage?.({ data: JSON.stringify({ audio: chunk1.toString('base64'), enc: 'pcm_s16le', idx: 1, sr: 24000, samples: 5 }) });
    mockWs.onmessage?.({ data: JSON.stringify({ audio: chunk2.toString('base64'), enc: 'pcm_s16le', idx: 2, sr: 24000, samples: 5 }) });
    mockWs.onmessage?.({ data: makeFinalMsg(3, 15) });

    const result = await collectStream(readable);

    expect(result.byteLength).toBe(30);
    // First 10 bytes should be 0x01, next 10 should be 0x02, last 10 should be 0x03
    expect(result.subarray(0, 10).every((b) => b === 0x01)).toBe(true);
    expect(result.subarray(10, 20).every((b) => b === 0x02)).toBe(true);
    expect(result.subarray(20, 30).every((b) => b === 0x03)).toBe(true);
  });

  it('destroys the stream with an error on WebSocket error', async () => {
    const readable = client.tts.toReadable({ text: 'Error test' });

    await new Promise<void>((r) => setTimeout(r, 10));

    mockWs.onmessage?.({ data: JSON.stringify({ error: 'internal server error' }) });

    await expect(collectStream(readable)).rejects.toThrow();
  });

  it('ends the stream cleanly when final message is received', async () => {
    const readable = client.tts.toReadable({ text: 'End test' });

    await new Promise<void>((r) => setTimeout(r, 10));

    mockWs.onmessage?.({ data: makeAudioMsg(0, 50) });
    mockWs.onmessage?.({ data: makeFinalMsg(1, 50) });

    const result = await collectStream(readable);
    expect(result.byteLength).toBe(100); // 50 samples * 2 bytes
  });

  it('creates the stream synchronously before audio arrives', () => {
    // The Readable must be returned immediately, not after the first chunk.
    const readable = client.tts.toReadable({ text: 'Sync test' });
    expect(readable).toBeDefined();
    expect(typeof readable.pipe).toBe('function');
    expect(typeof readable.on).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Multi-region tests
// ---------------------------------------------------------------------------

describe('KugelAudio multi-region', () => {
  it('detects EU region from key prefix and strips it', () => {
    const client = new KugelAudio({ apiKey: 'eu-ka_test123' });
    expect((client as any)._apiUrl).toBe('https://api.eu.kugelaudio.com');
    expect((client as any)._apiKey).toBe('ka_test123');
  });

  it('explicit region overrides key prefix', () => {
    const client = new KugelAudio({ apiKey: 'us-ka_test123', region: 'global' });
    expect((client as any)._apiUrl).toBe('https://api.kugelaudio.com');
    expect((client as any)._apiKey).toBe('ka_test123');
  });

  it('explicit apiUrl overrides region entirely', () => {
    const client = new KugelAudio({
      apiKey: 'us-ka_test123',
      region: 'global',
      apiUrl: 'https://custom.example.com',
    });
    expect((client as any)._apiUrl).toBe('https://custom.example.com');
    expect((client as any)._apiKey).toBe('ka_test123');
  });

  it('throws on invalid region', () => {
    expect(() => new KugelAudio({ apiKey: 'ka_test123', region: 'mars' as any })).toThrow(
      /Invalid region/
    );
  });

  it('ttsUrl defaults to the resolved region URL', () => {
    const client = new KugelAudio({ apiKey: 'us-ka_test123' });
    expect((client as any)._ttsUrl).toBe('https://api.kugelaudio.com');
  });

});

// ---------------------------------------------------------------------------
// Keepalive ping tests
// ---------------------------------------------------------------------------

describe('KugelAudio keepalive ping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls ws.ping() after each interval fires', async () => {
    const client = new KugelAudio({ apiKey: 'test-key-xxx', keepalivePingInterval: 1_000 });
    // Trigger the connection by opening a stream
    client.tts.toReadable({ text: 'ping test' });

    // Advance just enough for the mock WebSocket setTimeout(0) to fire (open event)
    await vi.advanceTimersByTimeAsync(10);

    // Now the WS is open and the keepalive setInterval is registered.
    // Advance 3 more seconds to fire the ping 3 times.
    await vi.advanceTimersByTimeAsync(3_000);

    expect(mockWs.ping).toBeDefined();
    expect((mockWs.ping as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not call ws.ping() when keepalive is disabled', async () => {
    const client = new KugelAudio({ apiKey: 'test-key-xxx', keepalivePingInterval: null });
    client.tts.toReadable({ text: 'no ping test' });

    // Let the WS open
    await vi.advanceTimersByTimeAsync(10);
    // Advance a long time — no pings should fire
    await vi.advanceTimersByTimeAsync(60_000);

    expect((mockWs.ping as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// StreamingSession tests (KUG-264)
// ---------------------------------------------------------------------------

function makeChunkCompleteMsg(chunkId: number, audioSeconds: number, genMs: number): string {
  return JSON.stringify({
    chunk_complete: true,
    chunk_id: chunkId,
    audio_seconds: audioSeconds,
    gen_ms: genMs,
  });
}

function makeSessionClosedMsg(totalAudioSeconds: number, totalTextChunks: number, totalAudioChunks: number): string {
  return JSON.stringify({
    session_closed: true,
    total_audio_seconds: totalAudioSeconds,
    total_text_chunks: totalTextChunks,
    total_audio_chunks: totalAudioChunks,
  });
}

function makeGenerationStartedMsg(chunkId: number, text: string): string {
  return JSON.stringify({
    generation_started: true,
    chunk_id: chunkId,
    text,
  });
}

function makeInterruptedMsg(): string {
  return JSON.stringify({ interrupted: true });
}

describe('StreamingSession', () => {
  let client: KugelAudio;

  beforeEach(() => {
    client = new KugelAudio({ apiKey: 'test-key-xxx' });
  });

  /**
   * Helper: make the mock's close() simulate real WebSocket behaviour —
   * once close() is called, onmessage is nulled (no more message delivery).
   * This reproduces the real-world timing issue where the server's
   * session_closed message arrives after the socket is torn down.
   */
  function makeCloseTearDown(): void {
    mockWs.close = vi.fn(() => {
      mockWs.readyState = 3; // CLOSED
      mockWs.onmessage = null;
    });
  }

  it('fires onSessionClosed when server sends session_closed after close()', async () => {
    const sessionClosedCalls: Array<{ totalAudioSeconds: number; totalTextChunks: number; totalAudioChunks: number }> = [];
    const chunkCompleteCalls: Array<{ chunkId: number; audioSeconds: number; genMs: number }> = [];

    const session = client.tts.streamingSession(
      { voiceId: 1 },
      {
        onChunkComplete: (chunkId, audioSeconds, genMs) => {
          chunkCompleteCalls.push({ chunkId, audioSeconds, genMs });
        },
        onSessionClosed: (totalAudioSeconds, totalTextChunks, totalAudioChunks) => {
          sessionClosedCalls.push({ totalAudioSeconds, totalTextChunks, totalAudioChunks });
        },
      },
    );

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    // Multi-send: simulate streaming LLM tokens
    session.send('Hello ');
    session.send('world. ');
    session.send('How are you?');

    // Server generates first chunk
    mockWs.onmessage?.({ data: makeGenerationStartedMsg(0, 'Hello world.') });
    mockWs.onmessage?.({ data: makeAudioMsg(0, 100) });
    mockWs.onmessage?.({ data: makeChunkCompleteMsg(0, 1.0, 100) });

    expect(chunkCompleteCalls).toHaveLength(1);

    // Make close() realistic: socket tears down immediately, killing onmessage
    makeCloseTearDown();

    // Client calls close() — must wait for session_closed before tearing down
    const closePromise = session.close();

    // Simulate server processing the final flush and sending responses
    // (this happens asynchronously on the server after receiving {close: true})
    mockWs.onmessage?.({ data: makeGenerationStartedMsg(1, 'How are you?') });
    mockWs.onmessage?.({ data: makeAudioMsg(1, 80) });
    mockWs.onmessage?.({ data: makeChunkCompleteMsg(1, 0.8, 90) });
    mockWs.onmessage?.({ data: makeSessionClosedMsg(1.8, 2, 4) });

    await closePromise;

    // onSessionClosed MUST have been called
    expect(sessionClosedCalls).toHaveLength(1);
    expect(sessionClosedCalls[0].totalAudioSeconds).toBe(1.8);
    expect(sessionClosedCalls[0].totalTextChunks).toBe(2);
    expect(sessionClosedCalls[0].totalAudioChunks).toBe(4);
  });

  it('fires onFinal (end-of-audio) before onSessionClosed on turn end (KUG-1238)', async () => {
    const order: string[] = [];
    let finalStats: { totalAudioSeconds: number; totalTextChunks: number; totalAudioChunks: number } | null = null;

    const session = client.tts.streamingSession(
      { voiceId: 1 },
      {
        onFinal: (totalAudioSeconds, totalTextChunks, totalAudioChunks) => {
          order.push('final');
          finalStats = { totalAudioSeconds, totalTextChunks, totalAudioChunks };
        },
        onSessionClosed: () => order.push('session_closed'),
      },
    );

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));
    session.send('Hello.', true);

    mockWs.onmessage?.({ data: makeAudioMsg(0, 100) });
    mockWs.onmessage?.({ data: makeChunkCompleteMsg(0, 1.0, 100) });
    mockWs.onmessage?.({
      data: JSON.stringify({
        final: true,
        total_audio_seconds: 1.0,
        total_text_chunks: 1,
        total_audio_chunks: 1,
      }),
    });
    mockWs.onmessage?.({ data: makeSessionClosedMsg(1.0, 1, 1) });

    expect(order).toEqual(['final', 'session_closed']);
    expect(finalStats!.totalAudioSeconds).toBe(1.0);
    expect(finalStats!.totalTextChunks).toBe(1);
    expect(finalStats!.totalAudioChunks).toBe(1);
  });

  it('exposes typed per-session usage (cost charged) on lastUsage', async () => {
    const session = client.tts.streamingSession({ voiceId: 1 }, {});
    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));
    session.send('Hello.');

    expect(session.lastUsage).toBeNull();

    mockWs.onmessage?.({
      data: JSON.stringify({
        session_closed: true,
        total_audio_seconds: 5.4,
        usage: {
          audio_seconds: 5.4,
          characters: 142,
          cost_cents: 0.49,
          currency: 'eur',
          model_id: 'kugel-3',
        },
      }),
    });

    expect(session.lastUsage).not.toBeNull();
    expect(session.lastUsage?.audioSeconds).toBe(5.4);
    expect(session.lastUsage?.characters).toBe(142);
    expect(session.lastUsage?.costCents).toBe(0.49);
    expect(session.lastUsage?.currency).toBe('eur');
    expect(session.lastUsage?.modelId).toBe('kugel-3');
    expect(session.lastUsage?.costAvailable).toBe(true);
  });

  it('falls back to total_audio_seconds for a legacy server with no usage block', async () => {
    const session = client.tts.streamingSession({ voiceId: 1 }, {});
    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));
    session.send('Hi.');

    mockWs.onmessage?.({ data: makeSessionClosedMsg(3.0, 1, 2) });

    expect(session.lastUsage?.audioSeconds).toBe(3.0);
    expect(session.lastUsage?.costCents).toBeNull();
    expect(session.lastUsage?.costAvailable).toBe(false);
  });

  it('resolves close() even if server never sends session_closed (quiet timeout)', async () => {
    const session = client.tts.streamingSession(
      { voiceId: 1 },
      {},
    );

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));
    session.send('Hello.');

    // Simulate some audio
    mockWs.onmessage?.({ data: makeAudioMsg(0, 50) });
    mockWs.onmessage?.({ data: makeChunkCompleteMsg(0, 0.5, 50) });

    makeCloseTearDown();
    vi.useFakeTimers();

    const closePromise = session.close();

    // No further server messages — quiet timeout (15 s) should resolve.
    await vi.advanceTimersByTimeAsync(16_000);

    await closePromise;

    vi.useRealTimers();

    // Should have cleaned up
    expect(session.isConnected).toBe(false);
  });

  /**
   * Regression: a slow final-flush that streams audio for longer than the
   * old 10 s wall-clock fuse must NOT be truncated. The quiet-timeout fix
   * resets on every incoming frame, so as long as the server keeps sending
   * audio, close() keeps waiting.
   */
  it('does not truncate a slow final flush that streams past the old 10 s fuse', async () => {
    const audioChunks: unknown[] = [];
    const sessionClosedCalls: unknown[] = [];

    const session = client.tts.streamingSession(
      { voiceId: 1 },
      {
        onChunk: (chunk) => audioChunks.push(chunk),
        onSessionClosed: (totalSecs, chunks, audioCnt) => {
          sessionClosedCalls.push({ totalSecs, chunks, audioCnt });
        },
      },
    );

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    // Buffer text without an explicit flush — server will flush on close.
    session.send('A long final paragraph that takes many seconds to render.');

    makeCloseTearDown();
    vi.useFakeTimers();

    const closePromise = session.close();

    // Server streams audio every 2 s for 18 s — well past the old 10 s fuse.
    // Each frame must reset the quiet timer so close() keeps waiting.
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      mockWs.onmessage?.({ data: makeAudioMsg(i, 200) });
    }

    // Server finally finishes generation and confirms close.
    mockWs.onmessage?.({ data: makeChunkCompleteMsg(0, 18.0, 17_500) });
    mockWs.onmessage?.({ data: makeSessionClosedMsg(18.0, 1, 9) });

    await closePromise;

    vi.useRealTimers();

    // All 9 audio frames from the slow final flush were delivered.
    expect(audioChunks).toHaveLength(9);
    // session_closed was observed (not truncated by a wall-clock fuse).
    expect(sessionClosedCalls).toHaveLength(1);
  });

  it('receives audio chunks from final flush before session_closed', async () => {
    const audioChunks: unknown[] = [];
    const sessionClosedCalls: unknown[] = [];

    const session = client.tts.streamingSession(
      { voiceId: 1 },
      {
        onChunk: (chunk) => audioChunks.push(chunk),
        onSessionClosed: (totalSecs, chunks, audioCnt) => {
          sessionClosedCalls.push({ totalSecs, chunks, audioCnt });
        },
      },
    );

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    // Send partial text that hasn't been flushed
    session.send('Partial text that');

    makeCloseTearDown();

    // Client closes — server flushes remaining text and sends audio
    const closePromise = session.close();

    // Server flushes and generates
    mockWs.onmessage?.({ data: makeGenerationStartedMsg(0, 'Partial text that') });
    mockWs.onmessage?.({ data: makeAudioMsg(0, 200) });
    mockWs.onmessage?.({ data: makeAudioMsg(1, 150) });
    mockWs.onmessage?.({ data: makeChunkCompleteMsg(0, 1.5, 120) });
    mockWs.onmessage?.({ data: makeSessionClosedMsg(1.5, 1, 2) });

    await closePromise;

    // Audio from final flush must have been received
    expect(audioChunks).toHaveLength(2);
    expect(sessionClosedCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // connect() awaitability — regression for the "StreamingSession not
  // connected" race fixed alongside KUG-421.
  // -------------------------------------------------------------------------

  it('connect() returns a promise that resolves when the WS is OPEN', async () => {
    const session = client.tts.streamingSession({ voiceId: 1 }, {});

    // Before await, the mock is still CONNECTING (readyState 0).
    const ready = session.connect();
    expect(session.isConnected).toBe(false);

    await ready;

    // After await, the WS is OPEN and send() works without throwing.
    expect(session.isConnected).toBe(true);
    expect(() => session.send('Hello.', true)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // cancelCurrent() — barge-in (KUG-1050)
  // -------------------------------------------------------------------------

  it('cancelCurrent() sends {cancel:true}, fires onInterrupted, keeps socket open', async () => {
    const interruptedCalls: number[] = [];

    const session = client.tts.streamingSession(
      { voiceId: 1 },
      { onInterrupted: () => interruptedCalls.push(1) },
    );

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    session.send('A very long sentence the user is about to talk over.');
    mockWs.onmessage?.({ data: makeAudioMsg(0, 100) });

    const cancelPromise = session.cancelCurrent();

    // The barge-in frame was sent to the server.
    const lastSent = JSON.parse(mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0] as string);
    expect(lastSent.cancel).toBe(true);

    // Server acks the barge-in.
    mockWs.onmessage?.({ data: makeInterruptedMsg() });
    await cancelPromise;

    // onInterrupted fired and the socket stayed open for the next turn.
    expect(interruptedCalls).toHaveLength(1);
    expect(session.isConnected).toBe(true);
    expect(mockWs.close).not.toHaveBeenCalled();
  });

  it('cancelCurrent() re-sends config on the next send (fresh server session)', async () => {
    const session = client.tts.streamingSession({ voiceId: 42 }, {});

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    // First send carries config (voice_id).
    session.send('Hello.');
    expect(JSON.parse(mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0] as string).voice_id).toBe(42);

    const cancelPromise = session.cancelCurrent();
    mockWs.onmessage?.({ data: makeInterruptedMsg() });
    await cancelPromise;

    // The server started a fresh session, so the next send must re-send config.
    session.send('Next turn.');
    expect(JSON.parse(mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0] as string).voice_id).toBe(42);
  });

  // -------------------------------------------------------------------------
  // dictionaryIds — per-request dictionary selection (KUG-1094)
  // -------------------------------------------------------------------------

  it('first send carries dictionary_ids when configured', async () => {
    const session = client.tts.streamingSession(
      { voiceId: 1, dictionaryIds: [7, 9] },
      {},
    );

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    session.send('Hello.');
    const sent = JSON.parse(
      mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0] as string
    );
    expect(sent.dictionary_ids).toEqual([7, 9]);
  });

  it('first send carries dictionary_ids: [] (explicit opt-out)', async () => {
    const session = client.tts.streamingSession(
      { voiceId: 1, dictionaryIds: [] },
      {},
    );

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    session.send('Hello.');
    const sent = JSON.parse(
      mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0] as string
    );
    expect(sent.dictionary_ids).toEqual([]);
  });

  it('cancelCurrent() resolves on quiet timeout if server never acks', async () => {
    const session = client.tts.streamingSession({ voiceId: 1 }, {});

    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));
    session.send('Hello.');

    vi.useFakeTimers();
    const cancelPromise = session.cancelCurrent();

    // No interrupted ack — the 5 s quiet timeout resolves it.
    await vi.advanceTimersByTimeAsync(6_000);
    await cancelPromise;

    vi.useRealTimers();
    // Socket was never closed; still reusable.
    expect(session.isConnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MultiContextSession barge-in — closeContext immediate (KUG-1050)
// ---------------------------------------------------------------------------

describe('MultiContextSession closeContext', () => {
  let client: KugelAudio;

  beforeEach(() => {
    client = new KugelAudio({ apiKey: 'test-key-xxx' });
  });

  it('closeContext(id, true) sends the immediate barge-in flag', async () => {
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    await session.connect({});

    session.closeContext('ctx1', true);

    const sent = JSON.parse(
      mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0] as string
    );
    expect(sent.close_context).toBe(true);
    expect(sent.context_id).toBe('ctx1');
    expect(sent.immediate).toBe(true);
  });

  it('maps ingress context-cap errors to typed callback errors', async () => {
    const errors: Array<{ contextId?: string; error: Error }> = [];
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    await session.connect({
      onError: (error, contextId) => errors.push({ contextId, error }),
    });

    mockWs.onmessage?.({
      data: JSON.stringify({
        error: 'Too many concurrent contexts',
        error_code: 'TOO_MANY_CONTEXTS',
        code: 429,
        context_id: 'ctx1',
      }),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].contextId).toBe('ctx1');
    expect(errors[0].error).toBeInstanceOf(RateLimitError);
    expect((errors[0].error as RateLimitError).statusCode).toBe(429);
    expect((errors[0].error as RateLimitError).errorCode).toBe('TOO_MANY_CONTEXTS');
  });

  it('fires onFinal per context on flush completion and graceful close (KUG-1238)', async () => {
    const finals: string[] = [];
    const closed: string[] = [];
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    await session.connect({
      onFinal: (contextId) => finals.push(contextId),
      onContextClosed: (contextId) => closed.push(contextId),
    });

    // Flush boundary: all audio admitted before the flush has been sent.
    mockWs.onmessage?.({
      data: JSON.stringify({ final: true, context_id: 'a' }),
    });
    expect(finals).toEqual(['a']);
    expect(closed).toEqual([]);

    // Graceful close: final precedes context_closed.
    mockWs.onmessage?.({
      data: JSON.stringify({ final: true, context_id: 'a' }),
    });
    mockWs.onmessage?.({
      data: JSON.stringify({ context_closed: true, context_id: 'a' }),
    });
    expect(finals).toEqual(['a', 'a']);
    expect(closed).toEqual(['a']);
  });

  it('exposes per-context usage on context_closed (per conversation)', async () => {
    const closed: Array<{ id: string; usage: unknown }> = [];
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    await session.connect({
      onContextClosed: (contextId, usage) => closed.push({ id: contextId, usage }),
    });

    mockWs.onmessage?.({
      data: JSON.stringify({
        context_closed: true,
        context_id: 'narrator',
        usage: { audio_seconds: 4.1, cost_cents: 0.37, currency: 'eur', model_id: 'kugel-3' },
      }),
    });

    // Available both via the callback arg and the per-context accessor
    expect(closed).toHaveLength(1);
    expect(closed[0].id).toBe('narrator');
    expect((closed[0].usage as { costCents: number }).costCents).toBe(0.37);

    const u = session.usageFor('narrator');
    expect(u?.audioSeconds).toBe(4.1);
    expect(u?.costCents).toBe(0.37);
    expect(u?.costAvailable).toBe(true);
    expect(session.usageFor('missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MultiContextSession createContext wire format (KUG-1233)
//
// The server binds a context's voice ONLY from voice_settings.voice_id at
// context creation. A top-level voice_id updates session config and leaves
// the context voiceless → MISSING_VOICE_ID on the first text. These tests
// pin the wire format so it cannot silently regress.
// ---------------------------------------------------------------------------

describe('MultiContextSession createContext wire format (KUG-1233)', () => {
  let client: KugelAudio;

  beforeEach(() => {
    client = new KugelAudio({ apiKey: 'test-key-xxx' });
  });

  it('puts voice_id inside voice_settings, never top-level', async () => {
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 42 });
    await session.connect({});

    session.createContext('narrator', { voiceId: 123 });

    const sent = JSON.parse(
      mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0] as string
    );
    expect(sent.context_id).toBe('narrator');
    expect(sent.voice_id).toBeUndefined();
    expect(sent.voice_settings).toBeDefined();
    expect(sent.voice_settings.voice_id).toBe(123);
  });

  it('send() to an unknown context auto-creates it with the default voice, even after session start', async () => {
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 42 });
    await session.connect({});

    // Simulate a started session (first context confirmed by the server).
    session.createContext('first');
    mockWs.onmessage?.({
      data: JSON.stringify({ session_started: true, session_id: 's1' }),
    });
    mockWs.onmessage?.({
      data: JSON.stringify({ context_created: true, context_id: 'first' }),
    });

    const callsBefore = mockWs.send.mock.calls.length;
    session.send('second', 'hello there', true);
    const frames = mockWs.send.mock.calls
      .slice(callsBefore)
      .map((c) => JSON.parse(c[0] as string));

    // First frame: the auto-create with voice_settings.voice_id; then the text.
    expect(frames).toHaveLength(2);
    expect(frames[0].context_id).toBe('second');
    expect(frames[0].voice_settings.voice_id).toBe(42);
    expect(frames[1].text).toBe('hello there');
    expect(frames[1].flush).toBe(true);
  });

  it('does not duplicate the create frame across repeated sends', async () => {
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 42 });
    await session.connect({});

    session.send('ctx', 'one');
    session.send('ctx', 'two');

    const frames = mockWs.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const creates = frames.filter((f) => f.voice_settings?.voice_id === 42);
    expect(creates).toHaveLength(1);
  });

  it('allows re-creating a context after the server closed it', async () => {
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 42 });
    await session.connect({});

    session.send('ctx', 'one');
    mockWs.onmessage?.({
      data: JSON.stringify({ context_created: true, context_id: 'ctx' }),
    });
    mockWs.onmessage?.({
      data: JSON.stringify({ context_closed: true, context_id: 'ctx' }),
    });

    const callsBefore = mockWs.send.mock.calls.length;
    session.send('ctx', 'again');
    const frames = mockWs.send.mock.calls
      .slice(callsBefore)
      .map((c) => JSON.parse(c[0] as string));
    expect(frames[0].voice_settings.voice_id).toBe(42);
    expect(frames[1].text).toBe('again');
  });
});

// ---------------------------------------------------------------------------
// updateSettings() — mid-connection generation-param changes (KUG-1166)
// ---------------------------------------------------------------------------

describe('updateSettings (KUG-1166)', () => {
  let client: KugelAudio;

  beforeEach(() => {
    client = new KugelAudio({ apiKey: 'test-key-xxx' });
  });

  const lastSent = () =>
    JSON.parse(mockWs.send.mock.calls[mockWs.send.mock.calls.length - 1][0] as string);

  it('stream: sends update_settings (snake_case) and resolves with effective settings', async () => {
    const session = client.tts.streamingSession({ voiceId: 1, cfgScale: 2.0 }, {});
    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    const p = session.updateSettings({ cfgScale: 1.5, speed: 1.1 });
    expect(lastSent().update_settings).toEqual({ cfg_scale: 1.5, speed: 1.1 });

    mockWs.onmessage?.({
      data: JSON.stringify({ settings_updated: true, settings: { cfg_scale: 1.5, speed: 1.1 } }),
    });
    const eff = await p;
    expect(eff.cfgScale).toBe(1.5);
    expect(eff.speed).toBe(1.1);
  });

  it('stream: syncs local config so the next first send carries the new value', async () => {
    const session = client.tts.streamingSession({ voiceId: 1, cfgScale: 2.0 }, {});
    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    const p = session.updateSettings({ cfgScale: 1.5 });
    mockWs.onmessage?.({
      data: JSON.stringify({ settings_updated: true, settings: { cfg_scale: 1.5 } }),
    });
    await p;

    session.send('Hello.');
    // First send serializes config — it must carry the updated cfg_scale, not 2.0.
    expect(lastSent().cfg_scale).toBe(1.5);
  });

  it('stream: server rejection rejects the promise without changing local defaults', async () => {
    const session = client.tts.streamingSession({ voiceId: 1, cfgScale: 2.0 }, {});
    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));

    const p = session.updateSettings({ cfgScale: 99 });
    mockWs.onmessage?.({
      data: JSON.stringify({
        error: 'Invalid settings update: cfg_scale: out of range',
        error_code: 'VALIDATION_ERROR',
        code: 400,
      }),
    });
    await expect(p).rejects.toThrow(/Invalid settings update/);

    session.send('Hello.');
    expect(lastSent().cfg_scale).toBe(2.0);
  });

  it('stream: empty update throws synchronously', async () => {
    const session = client.tts.streamingSession({ voiceId: 1 }, {});
    session.connect();
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(() => session.updateSettings({})).toThrow(/at least one parameter/);
  });

  it('multi: session-scoped update acked, no context_id', async () => {
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1, cfgScale: 1.0 });
    await session.connect({});

    const p = session.updateSettings({ cfgScale: 2.5, normalize: false });
    expect(lastSent().update_settings).toEqual({ cfg_scale: 2.5, normalize: false });
    expect(lastSent().context_id).toBeUndefined();

    mockWs.onmessage?.({
      data: JSON.stringify({ settings_updated: true, settings: { cfg_scale: 2.5, normalize: false } }),
    });
    const eff = await p;
    expect(eff.cfgScale).toBe(2.5);
    expect(eff.normalize).toBe(false);
  });

  it('multi: server rejection does not change local defaults', async () => {
    // cfgScale 2.0 is inside the client-side clamp band [1.2, 2.5] so the
    // re-send below reflects the local default verbatim — a value below 1.2
    // would be clamped up and mask whether the rejected update poisoned it.
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1, cfgScale: 2.0 });
    await session.connect({});

    const p = session.updateSettings({ cfgScale: 99 });
    mockWs.onmessage?.({
      data: JSON.stringify({
        error: 'Invalid settings update: cfg_scale: out of range',
        error_code: 'VALIDATION_ERROR',
        code: 400,
      }),
    });
    await expect(p).rejects.toThrow(/Invalid settings update/);

    session.createContext('narrator');
    expect(lastSent().cfg_scale).toBe(2.0);
  });
});

describe('ASRResource', () => {
  it('uses the public multipart transcription contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'Ich heiße Müller.',
          transcript: 'Ich heiße Müller.',
          language: 'de',
          duration_s: 1.5,
          model: 'luchs-1',
          model_revision: '7278e1e70fe206f11671096ffdd38061171dd6e5',
          word_alternatives: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });

    const result = await client.asr.transcribe({
      audio: new Blob(['RIFFdata'], { type: 'audio/wav' }),
      language: 'de',
    });

    expect(result.text).toBe('Ich heiße Müller.');
    expect(result.model).toBe('luchs-1');
    expect(result.model_revision).toBe('7278e1e70fe206f11671096ffdd38061171dd6e5');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.kugelaudio.com/v1/audio/transcriptions',
    );
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get('model')).toBe('luchs-1');
    expect(body.get('language')).toBe('de');
    vi.unstubAllGlobals();
  });

  it('defaults the outgoing model field to luchs-1 when omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: 'hi',
          transcript: 'hi',
          language: 'en',
          duration_s: 0.5,
          model: 'luchs-1',
          word_alternatives: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new KugelAudio({ apiKey: 'test-key-xxx' });

    await client.asr.transcribe({
      audio: new Blob(['RIFFdata'], { type: 'audio/wav' }),
    });

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get('model')).toBe('luchs-1');
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Rolling-deploy closes (1012 / 1013) surface a typed, retryable error
// ---------------------------------------------------------------------------

describe('rolling-deploy close codes', () => {
  let client: KugelAudio;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new KugelAudio({ apiKey: 'test-key-xxx' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Await a connect() promise: the mock socket opens on a 0 ms timer. */
  async function opened(p: Promise<void>): Promise<void> {
    await vi.advanceTimersByTimeAsync(1);
    await p;
  }

  /** Let the 1 s retryAfter delay and the reconnect handshake run. */
  async function replayed(): Promise<void> {
    await vi.advanceTimersByTimeAsync(1100);
  }

  function sentOn(ws: MockWs): Record<string, any>[] {
    return ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
  }

  function audioForContext(contextId: string): string {
    return JSON.stringify({ ...JSON.parse(makeAudioMsg(0)), context_id: contextId });
  }

  it('StreamingSession: completing one turn retains the next for replay', async () => {
    const errors: Error[] = [];
    const session = client.tts.streamingSession({ voiceId: 7 }, { onError: e => errors.push(e) });
    await opened(session.connect());
    session.send('first', true);
    session.send('second', true);
    mockWs.onmessage?.({ data: makeAudioMsg(0) });
    mockWs.onmessage?.({ data: JSON.stringify({ final: true }) });
    mockWs.onmessage?.({ data: JSON.stringify({ session_closed: true }) });
    mockWs.onclose?.({ code: 1012 });
    await replayed();

    expect(sentOn(mockWs).map(frame => frame.text)).toEqual(['second']);
    expect(errors).toEqual([]);
    // A replayed queued turn still has a one-retry budget.
    mockWs.onclose?.({ code: 1012 });
    expect(errors[0]).toBeInstanceOf(ServerRestartingError);
  });

  it('MultiContextSession: final retires only the acknowledged flush', async () => {
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 7 });
    await opened(session.connect({}));
    session.send('a', 'first', true);
    session.send('a', 'second', true);
    mockWs.onmessage?.({ data: audioForContext('a') });
    mockWs.onmessage?.({ data: JSON.stringify({ final: true, context_id: 'a' }) });
    mockWs.onclose?.({ code: 1012 });
    await replayed();

    expect(sentOn(mockWs).filter(frame => frame.text !== ' ').map(frame => frame.text))
      .toEqual(['second']);
  });

  it('StreamingSession: endSession preserves text queued by its completion callback', async () => {
    const session = client.tts.streamingSession({ voiceId: 7 }, {
      onSessionClosed: () => session.send('next', true),
    });
    await opened(session.connect());
    session.send('first');
    const ending = session.endSession();
    mockWs.onmessage?.({ data: JSON.stringify({ session_closed: true }) });
    await ending;
    mockWs.onclose?.({ code: 1012 });
    await replayed();

    expect(sentOn(mockWs).map(frame => frame.text)).toEqual(['next']);
  });

  it.each([false, true])('StreamingSession: close stays closed when restart arrives (after return: %s)', async (afterReturn) => {
    const session = client.tts.streamingSession({ voiceId: 7 }, {});
    await opened(session.connect());
    const oldWs = mockWs;
    const closing = session.close();
    oldWs.onmessage?.({ data: JSON.stringify({ session_closed: true }) });
    if (afterReturn) await closing;
    oldWs.onclose?.({ code: 1012 });
    await closing;
    await replayed();

    expect(mockWs).toBe(oldWs);
    expect(session.isConnected).toBe(false);
    await opened(session.connect());
    expect(session.isConnected).toBe(true);
  });

  it('StreamingSession: closing an idle reconnect gap does not open another socket', async () => {
    const session = client.tts.streamingSession({ voiceId: 7 }, {});
    await opened(session.connect());
    const oldWs = mockWs;
    oldWs.onclose?.({ code: 1012 });
    const closing = session.close();
    await replayed();
    await vi.advanceTimersByTimeAsync(15000);
    await closing;

    expect(mockWs).toBe(oldWs);
    expect(session.isConnected).toBe(false);
  });

  it('MultiContextSession: a late restart close cannot reopen an explicitly closed session', async () => {
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 7 });
    await opened(session.connect({}));
    const oldWs = mockWs;
    session.close();
    oldWs.onclose?.({ code: 1012 });
    await replayed();

    expect(mockWs).toBe(oldWs);
    expect(session.isConnected).toBe(false);
  });

  it('StreamingSession: 1012 before any audio replays the turn transparently', async () => {
    const errors: Error[] = [];
    const restarts: ServerRestartingError[] = [];
    const session = client.tts.streamingSession(
      { voiceId: 7 },
      { onError: (e) => errors.push(e), onServerRestart: (e) => restarts.push(e) },
    );
    await opened(session.connect());
    session.send('hello');
    const firstWs = mockWs;

    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });
    await replayed();

    // The caller sees no error: a fresh socket carries the same turn.
    expect(errors).toHaveLength(0);
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toBeInstanceOf(ServerRestartingError);
    expect(mockWs).not.toBe(firstWs);
    expect(session.isConnected).toBe(true);
    const replay = sentOn(mockWs);
    expect(replay).toHaveLength(1);
    expect(replay[0].text).toBe('hello');
    expect(replay[0].voice_id).toBe(7); // config re-sent on the new socket
  });

  it('StreamingSession: text sent during the reconnect gap goes out after the replay', async () => {
    const errors: Error[] = [];
    const session = client.tts.streamingSession(
      { voiceId: 7 },
      { onError: (e) => errors.push(e) },
    );
    await opened(session.connect());
    session.send('one');

    mockWs.onclose?.({ code: 1013, reason: 'try again later' });
    session.send('two', true); // queued, not thrown
    await replayed();

    expect(errors).toHaveLength(0);
    const replay = sentOn(mockWs);
    expect(replay.map((m) => m.text)).toEqual(['one', 'two']);
    expect(replay[0].voice_id).toBe(7);
    expect(replay[1].voice_id).toBeUndefined();
    expect(replay[1].flush).toBe(true);
  });

  it('StreamingSession: 1012 after audio raises ServerRestartingError and resets state', async () => {
    const errors: Error[] = [];
    const restarts: ServerRestartingError[] = [];
    const session = client.tts.streamingSession(
      { voiceId: 7 },
      { onError: (e) => errors.push(e), onServerRestart: (e) => restarts.push(e) },
    );
    await opened(session.connect());
    session.send('hello');
    mockWs.onmessage?.({ data: makeAudioMsg(0) });

    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });
    await replayed();

    // Replaying would repeat audio the listener already heard.
    expect(restarts).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ServerRestartingError);
    expect(errors[0]).toBeInstanceOf(ConnectionError);
    expect((errors[0] as ServerRestartingError).retryAfter).toBe(1);
    expect((errors[0] as ServerRestartingError).statusCode).toBe(503);
    expect(session.isConnected).toBe(false);
    expect(() => session.send('again')).toThrow(/not connected/);

    // Reconnecting by hand starts a fresh turn and re-sends the config.
    await opened(session.connect());
    session.send('again');
    expect(session.isConnected).toBe(true);
    const sent = sentOn(mockWs);
    expect(sent[0].voice_id).toBe(7);
    expect(sent[0].text).toBe('again');
  });

  it('StreamingSession: a second 1012 in the same turn raises', async () => {
    const errors: Error[] = [];
    const session = client.tts.streamingSession(
      { voiceId: 1 },
      { onError: (e) => errors.push(e) },
    );
    await opened(session.connect());
    session.send('hello');

    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });
    await replayed();
    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });
    await replayed();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ServerRestartingError);
    expect(session.isConnected).toBe(false);
  });

  it('StreamingSession: 1012 with nothing pending reconnects quietly', async () => {
    const errors: Error[] = [];
    const session = client.tts.streamingSession(
      { voiceId: 1 },
      { onError: (e) => errors.push(e) },
    );
    await opened(session.connect());

    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });
    await replayed();

    expect(errors).toHaveLength(0);
    expect(session.isConnected).toBe(true);
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('StreamingSession: 1000 still ends cleanly without an error', async () => {
    const errors: Error[] = [];
    const session = client.tts.streamingSession(
      { voiceId: 1 },
      { onError: (e) => errors.push(e) },
    );
    await opened(session.connect());

    mockWs.onclose?.({ code: 1000 });
    await replayed();

    expect(errors).toHaveLength(0);
    expect(session.isConnected).toBe(false);
  });

  it('MultiContextSession: 1012 before audio re-creates contexts and replays', async () => {
    const errors: Error[] = [];
    const restarts: ServerRestartingError[] = [];
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    await opened(
      session.connect({
        onError: (e) => errors.push(e),
        onServerRestart: (e) => restarts.push(e),
      }),
    );
    session.createContext('a', { voiceId: 7 });
    session.send('a', 'hello');

    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });
    await replayed();

    expect(errors).toHaveLength(0);
    expect(restarts).toHaveLength(1);
    expect(session.isConnected).toBe(true);
    const replay = sentOn(mockWs);
    expect(replay[0].context_id).toBe('a');
    expect(replay[0].voice_settings.voice_id).toBe(7);
    expect(replay[1]).toEqual({ text: 'hello', context_id: 'a', flush: false });
  });

  it('MultiContextSession: a context that already spoke errors, the others replay', async () => {
    const errors: Array<[Error, string | undefined]> = [];
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    await opened(
      session.connect({ onError: (e, ctx) => errors.push([e, ctx]) }),
    );
    session.createContext('a', { voiceId: 7 });
    session.createContext('b', { voiceId: 8 });
    session.send('a', 'spoken');
    session.send('b', 'pending');
    mockWs.onmessage?.({ data: audioForContext('a') });

    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });
    await replayed();

    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBeInstanceOf(ServerRestartingError);
    expect(errors[0][1]).toBe('a'); // only the context that lost audio
    const replay = sentOn(mockWs);
    expect(replay.map((m) => m.context_id)).toEqual(['b', 'b']);
    expect(replay[0].voice_settings.voice_id).toBe(8);
    expect(replay[1]).toEqual({ text: 'pending', context_id: 'b', flush: false });
  });

  it('MultiContextSession: 1012 with every context already speaking raises', async () => {
    const errors: Array<[Error, string | undefined]> = [];
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    await opened(
      session.connect({ onError: (e, ctx) => errors.push([e, ctx]) }),
    );
    session.createContext('a', { voiceId: 7 });
    session.send('a', 'spoken');
    mockWs.onmessage?.({ data: audioForContext('a') });

    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });
    await replayed();

    expect(errors.map((e) => e[1])).toEqual(['a', undefined]);
    expect(errors[1][0]).toBeInstanceOf(ServerRestartingError);
    expect(session.isConnected).toBe(false);
  });

  it('MultiContextSession: 1000 still ends cleanly', async () => {
    const errors: Error[] = [];
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 1 });
    await opened(session.connect({ onError: (e) => errors.push(e) }));

    mockWs.onclose?.({ code: 1000 });
    await replayed();

    expect(errors).toHaveLength(0);
    expect(session.isConnected).toBe(false);
  });

  it('pooled stream(): 1012 before audio re-issues the request once', async () => {
    const errors: Error[] = [];
    const restarts: ServerRestartingError[] = [];
    const chunks: number[] = [];
    const pending = client.tts.stream(
      { text: 'hi', voiceId: 1 },
      {
        onChunk: (c) => chunks.push(c.index),
        onError: (e) => errors.push(e),
        onServerRestart: (e) => restarts.push(e),
      },
    );
    await vi.advanceTimersByTimeAsync(1);

    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });
    await replayed();

    expect(restarts).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(sentOn(mockWs)[0].text).toBe('hi'); // request re-sent verbatim
    mockWs.onmessage?.({ data: makeAudioMsg(0) });
    mockWs.onmessage?.({ data: makeFinalMsg(1, 100) });

    await expect(pending).resolves.toBeUndefined();
    expect(chunks).toEqual([0]);
  });

  it('pooled stream(): 1012 after audio rejects with ServerRestartingError', async () => {
    const errors: Error[] = [];
    const pending = client.tts.stream(
      { text: 'hi', voiceId: 1 },
      { onError: (e) => errors.push(e) },
    );
    await vi.advanceTimersByTimeAsync(1);
    mockWs.onmessage?.({ data: makeAudioMsg(0) });

    mockWs.onclose?.({ code: 1012, reason: 'server restarting' });

    await expect(pending).rejects.toBeInstanceOf(ServerRestartingError);
    expect(errors[0]).toBeInstanceOf(ServerRestartingError);
  });

  it('unpooled stream(): 1013 before audio re-issues the request once', async () => {
    const chunks: number[] = [];
    const pending = client.tts.stream(
      { text: 'hi', voiceId: 1 },
      { onChunk: (c) => chunks.push(c.index) },
      false,
    );
    await vi.advanceTimersByTimeAsync(1);

    mockWs.onclose?.({ code: 1013, reason: 'try again later' });
    await replayed();

    expect(sentOn(mockWs)[0].text).toBe('hi');
    mockWs.onmessage?.({ data: makeAudioMsg(0) });
    mockWs.onmessage?.({ data: makeFinalMsg(1, 100) });

    await expect(pending).resolves.toBeUndefined();
    expect(chunks).toEqual([0]);
  });

  it('unpooled stream(): 1013 after audio rejects with ServerRestartingError', async () => {
    const pending = client.tts.stream({ text: 'hi', voiceId: 1 }, {}, false);
    await vi.advanceTimersByTimeAsync(1);
    mockWs.onmessage?.({ data: makeAudioMsg(0) });

    mockWs.onclose?.({ code: 1013, reason: 'try again later' });

    await expect(pending).rejects.toBeInstanceOf(ServerRestartingError);
  });
});

// ---------------------------------------------------------------------------
// Closes that end a stream without a `final` frame
// ---------------------------------------------------------------------------

describe('stream() closes with no final frame', () => {
  let client: KugelAudio;

  beforeEach(() => {
    client = new KugelAudio({ apiKey: 'test-key-xxx' });
  });

  /** Let the mock socket's open timer run. Real timers: a hang hits the
   *  per-test timeout instead of stalling the suite. */
  const connected = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  describe.each([
    { label: 'pooled', pool: true },
    { label: 'unpooled', pool: false },
  ])('$label stream()', ({ pool }) => {
    it.each([1006, 1011, 1008])(
      'rejects on close %i instead of hanging forever',
      async (code) => {
        const errors: Error[] = [];
        let closed = 0;
        const pending = client.tts.stream(
          { text: 'hi', voiceId: 1, language: 'en' },
          { onError: (e) => errors.push(e), onClose: () => { closed += 1; } },
          pool,
        );
        await connected();
        mockWs.onmessage?.({ data: makeAudioMsg(0) });

        mockWs.onclose?.({ code });

        await expect(pending).rejects.toBeInstanceOf(ConnectionError);
        await expect(pending).rejects.toThrow(new RegExp(`code ${code}`));
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(ConnectionError);
        expect(closed).toBe(1);
      },
      2000,
    );

    it('rejects on a bare 1000 that arrives before the final frame', async () => {
      const pending = client.tts.stream(
        { text: 'hi', voiceId: 1, language: 'en' },
        {},
        pool,
      );
      await connected();

      mockWs.onclose?.({ code: 1000 });

      await expect(pending).rejects.toBeInstanceOf(ConnectionError);
      await expect(pending).rejects.toThrow(/incomplete/);
    }, 2000);

    it('keeps the specific error for a recognised close code', async () => {
      const pending = client.tts.stream(
        { text: 'hi', voiceId: 1, language: 'en' },
        {},
        pool,
      );
      await connected();
      mockWs.onmessage?.({ data: makeAudioMsg(0) });

      mockWs.onclose?.({ code: 4029 });

      await expect(pending).rejects.toBeInstanceOf(RateLimitError);
    }, 2000);

    it('still resolves for a completed stream: final, then close', async () => {
      const errors: Error[] = [];
      const chunks: number[] = [];
      const pending = client.tts.stream(
        { text: 'hi', voiceId: 1, language: 'en' },
        { onChunk: (c) => chunks.push(c.index), onError: (e) => errors.push(e) },
        pool,
      );
      await connected();
      mockWs.onmessage?.({ data: makeAudioMsg(0) });
      mockWs.onmessage?.({ data: makeFinalMsg(1, 100) });

      mockWs.onclose?.({ code: 1000 });

      await expect(pending).resolves.toBeUndefined();
      expect(chunks).toEqual([0]);
      expect(errors).toEqual([]);
    }, 2000);
  });

  it('pooled stream(): a close before the socket opens rejects the handshake', async () => {
    const pending = client.tts.stream({ text: 'hi', voiceId: 1, language: 'en' }, {});
    // The socket is constructed synchronously; close it before its open timer.
    mockWs.onclose?.({ code: 1011, reason: 'internal error' });

    await expect(pending).rejects.toBeInstanceOf(ConnectionError);
    await expect(pending).rejects.toThrow(/before ready \(code 1011\)/);
  }, 2000);
});
