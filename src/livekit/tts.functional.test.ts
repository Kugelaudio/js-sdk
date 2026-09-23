/**
 * Functional tests for the LiveKit plugin against a mock `/ws/tts/multi`
 * server (see `./mockServer`) that speaks the real ingress wire protocol.
 *
 * These tests exercise the actual WebSocket state machine end to end:
 * chunked synthesis, streaming synthesis, error frames, barge-in, and
 * connection reuse. Connection-acquisition timing/locking lives in
 * `tts.prewarm.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initializeLogger, type APIError } from '@livekit/agents';

import { FRAME_BYTES, MockMultiServer } from './mockServer';
import { SynthesizeStream, TTS } from './tts';

let server: MockMultiServer;
let baseURL: string;
const openTTS: TTS[] = [];

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(async () => {
  for (const t of openTTS.splice(0)) await t.close();
  await server?.close();
});

async function setup(): Promise<TTS> {
  server = new MockMultiServer();
  baseURL = await server.listen();
  const instance = new TTS({ apiKey: 'test-key', baseURL, language: 'en' });
  openTTS.push(instance);
  return instance;
}

describe('LiveKit plugin against mock /ws/tts/multi server', () => {
  it('chunked synthesize returns all audio with the final flag on the last frame', async () => {
    const instance = await setup();
    const stream = instance.synthesize('Hallo Welt');

    const events = [];
    for await (const event of stream) events.push(event);

    expect(events.length).toBeGreaterThan(0);
    const totalSamples = events.reduce((sum, e) => sum + e.frame.samplesPerChannel, 0);
    expect(totalSamples).toBe((2 * FRAME_BYTES) / 2);
    expect(events[events.length - 1]!.final).toBe(true);
    expect(events.slice(0, -1).every((e) => !e.final)).toBe(true);
    expect(events.every((e) => e.frame.sampleRate === 24000)).toBe(true);

    // Word timestamps ride on the frame emitted after they arrived.
    const timed = events.flatMap((e) => e.timedTranscripts ?? []);
    expect(timed).toHaveLength(1);
    expect(timed[0]!.text).toBe('hello');
    expect(timed[0]!.startTime).toBe(0);
    expect(timed[0]!.endTime).toBe(0.5);

    // First message of the context carried the session config exactly once.
    const [ctx] = [...server.contexts.values()];
    expect(ctx!.configMessages).toHaveLength(1);
    expect(ctx!.configMessages[0]).toMatchObject({
      model_id: 'kugel-3',
      sample_rate: 24000,
      language: 'en',
      normalize: true,
      word_timestamps: false,
    });
    expect(ctx!.closed).toBe(true);
    expect(ctx!.immediateClose).toBe(false);
  });

  it('streaming synthesize forwards tokens and drains the tail gracefully', async () => {
    const instance = await setup();
    const stream = instance.stream();

    stream.pushText('Guten ');
    stream.pushText('Tag');
    stream.endInput();

    const events = [];
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const totalSamples = events.reduce((sum, e) => sum + e.frame.samplesPerChannel, 0);
    expect(totalSamples).toBe((2 * FRAME_BYTES) / 2);
    expect(events[events.length - 1]!.final).toBe(true);

    // The server received the concatenated text and a graceful close.
    const [ctx] = [...server.contexts.values()];
    expect(ctx!.closed).toBe(true);
    expect(ctx!.immediateClose).toBe(false);
    const textMessages = server.messages
      .filter((m) => typeof m.text === 'string')
      .map((m) => m.text);
    expect(textMessages.join('')).toBe('Guten Tag');
  });

  it('delivers the sub-frame sentence tail on chunk_complete without waiting for more audio', async () => {
    const instance = await setup();
    // 25ms tail below the 100ms AudioByteStream frame size: without the
    // chunk_complete flush it stays buffered until the next sentence's bytes
    // arrive (audible gap/click at the sentence seam).
    server.tailBytesPerFlush = 1200;

    const stream = instance.stream();
    stream.pushText('Erster Satz.');
    stream.flush();
    // Input deliberately stays open — the LLM is "still talking". The full
    // audio of the flushed sentence must arrive anyway.
    const events: { frame: { samplesPerChannel: number } }[] = [];
    const consume = (async () => {
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) break;
        events.push(event);
      }
    })();

    const expectedSamples = (2 * FRAME_BYTES + 1200) / 2;
    await expect
      .poll(() => events.reduce((sum, e) => sum + e.frame.samplesPerChannel, 0), {
        timeout: 3000,
      })
      .toBe(expectedSamples);

    stream.close();
    await consume;
  });

  it('sends speed as a top-level config key and recycles the socket on updateOptions', async () => {
    server = new MockMultiServer();
    baseURL = await server.listen();
    const instance = new TTS({ apiKey: 'test-key', baseURL, language: 'en', speed: 0.9 });
    openTTS.push(instance);

    for await (const _ of instance.synthesize('erste')) {
      // drain
    }

    const configs = server.messages.filter((m) => m.model_id !== undefined);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.speed).toBe(0.9);
    // Nesting it in voice_settings would be silently dropped by the server.
    expect(configs[0]!.voice_settings ?? {}).not.toHaveProperty('speed');

    // speed is session-wide on /ws/tts/multi, so a change must open a fresh
    // session rather than mutate the live one.
    instance.updateOptions({ speed: 1.2 });
    for await (const _ of instance.synthesize('zweite')) {
      // drain
    }

    expect(server.connectionCount).toBe(2);
    const latest = server.messages.filter((m) => m.model_id !== undefined);
    expect(latest).toHaveLength(2);
    expect(latest[1]!.speed).toBe(1.2);
  });

  it('sends temperature as a top-level config key and recycles the socket on updateOptions', async () => {
    server = new MockMultiServer();
    baseURL = await server.listen();
    const instance = new TTS({ apiKey: 'test-key', baseURL, language: 'en', temperature: 0.2 });
    openTTS.push(instance);

    for await (const _ of instance.synthesize('erste')) {
      // drain
    }

    const configs = server.messages.filter((m) => m.model_id !== undefined);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.temperature).toBe(0.2);
    expect(configs[0]!.voice_settings ?? {}).not.toHaveProperty('temperature');

    instance.updateOptions({ temperature: 0.8 });
    for await (const _ of instance.synthesize('zweite')) {
      // drain
    }

    expect(server.connectionCount).toBe(2);
    const latest = server.messages.filter((m) => m.model_id !== undefined);
    expect(latest[1]!.temperature).toBe(0.8);
  });

  it('reuses one WebSocket connection across sequential requests', async () => {
    const instance = await setup();

    for (const text of ['erste', 'zweite']) {
      const stream = instance.synthesize(text);
      for await (const _ of stream) {
        // drain
      }
    }

    expect(server.connectionCount).toBe(1);
    // Each context got its own config-bearing first message.
    expect(server.contexts.size).toBe(2);
    for (const ctx of server.contexts.values()) {
      expect(ctx.configMessages).toHaveLength(1);
    }
  });

  it('maps server error frames to a non-retryable APIStatusError', async () => {
    const instance = await setup();
    server.errorFrame = {
      error: 'text validation failed',
      error_code: 'VALIDATION_ERROR',
      code: 400,
    };

    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));

    const stream = instance.stream();
    stream.pushText('kaputt');
    stream.endInput();

    const events = [];
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      events.push(event);
    }

    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('text validation failed');
    // 400-class errors must not be retried by the framework.
    expect((errors[0] as APIError).retryable).toBe(false);
  });

  it.each(['streaming', 'chunked'] as const)('fails every pending %s context on an unscoped error and reconnects without stale audio', async (mode) => {
    const instance = await setup();
    server.silent = true;
    const connection = await instance.currentConnection();
    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));
    const connOptions = { maxRetry: 0, retryIntervalMs: 10, timeoutMs: 5000 };
    const streams = [0, 1].map(() => mode === 'streaming'
      ? instance.stream({ connOptions })
      : instance.synthesize('waiting for audio', connOptions));
    const audioSamples = [0, 0];
    const consumers = streams.map(async (stream, index) => {
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) break;
        audioSamples[index]! += event.frame.samplesPerChannel;
      }
    });
    streams.forEach((stream) => {
      if (stream instanceof SynthesizeStream) stream.pushText('waiting for audio');
    });
    await expect.poll(() => server.messages.filter((m) => m.text).length).toBe(2);
    const contextIds = server.messages.filter((m) => m.text).map((m) => m.context_id);
    const errorFrame = {
      error: 'model temporarily unavailable',
      error_code: 'MODEL_UNAVAILABLE',
      code: 503,
      retry_after: 2,
      details: { operation: 'get_diagnostics' },
    };
    const [socket] = [...server.wss.clients];
    socket!.send(JSON.stringify(errorFrame));
    // These frames can already be in flight when the session failure arrives.
    for (const contextId of contextIds) {
      socket!.send(JSON.stringify({
        context_id: contextId,
        audio: Buffer.alloc(FRAME_BYTES).toString('base64'),
      }));
      socket!.send(JSON.stringify({ context_id: contextId, context_closed: true }));
    }

    await expect.poll(() => errors.length, { timeout: 1000 }).toBe(2);
    await Promise.all(consumers);
    expect(audioSamples).toEqual([0, 0]);
    for (const error of errors) {
      expect(error.message).toContain(errorFrame.error);
      expect(error).toMatchObject({
        name: 'APIStatusError',
        statusCode: 503,
        body: errorFrame,
        retryable: true,
      });
    }
    expect(connection.isCurrent).toBe(false);
    expect(connection.closed).toBe(true);
    connection.sendText('late-failed-context', 'must not be sent', true);
    server.silent = false;
    const recovered = [];
    for await (const event of instance.synthesize('recovered')) recovered.push(event);
    expect(recovered.length).toBeGreaterThan(0);
    expect(server.connectionCount).toBe(2);
    expect(server.messages.some((m) => m.context_id === 'late-failed-context')).toBe(false);
  });

  it('retries chunked synthesis promptly on a fresh connection after an unscoped error', async () => {
    const instance = await setup();
    server.silent = true;
    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));
    const stream = instance.synthesize('retry this sentence', {
      maxRetry: 1, retryIntervalMs: 10, timeoutMs: 5000,
    });
    let samples = 0;
    const consume = (async () => {
      for await (const event of stream) samples += event.frame.samplesPerChannel;
    })();
    await expect.poll(() => server.messages.filter((m) => m.text).length).toBe(1);
    const [socket] = [...server.wss.clients];
    socket!.send(JSON.stringify({
      error: 'model temporarily unavailable', error_code: 'MODEL_UNAVAILABLE', code: 503,
    }));
    server.silent = false;
    await expect.poll(() => server.connectionCount, { timeout: 1000 }).toBe(2);
    await consume;
    expect(samples).toBe(FRAME_BYTES);
    expect(server.messages.filter((m) => m.text === 'retry this sentence')).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it.each([
    { ended: false, text: 'must not disappear on retry' },
    { ended: true, text: 'must not disappear on retry' },
    { ended: false, text: '' },
  ])('reports streaming failure after starting the input reader ($ended, $text)', async ({ ended, text }) => {
    const instance = await setup();
    server.silent = true;
    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));
    const stream = instance.stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 10, timeoutMs: 5000 },
    });
    let audioSamples = 0;
    const consume = (async () => {
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) break;
        audioSamples += event.frame.samplesPerChannel;
      }
    })();
    stream.pushText(text);
    stream.flush();
    if (ended) stream.endInput();
    await expect.poll(() => server.messages.some((m) => m.flush)).toBe(true);
    const [socket] = [...server.wss.clients];
    const errorFrame = {
      error: 'temporarily unavailable', error_code: 'MODEL_UNAVAILABLE', code: 503,
    };
    socket!.send(JSON.stringify(errorFrame));
    server.silent = false;
    await expect.poll(() => errors.length, { timeout: 1000 }).toBe(1);
    await consume;
    expect(audioSamples).toBe(0);
    expect(errors[0]).toMatchObject({ statusCode: 503, body: errorFrame });
    expect(server.connectionCount).toBe(1);
  });

  it('reports the original chunked error when reconnect retries are exhausted', async () => {
    const instance = await setup();
    server.silent = true;
    const errorFrame = {
      error: 'still unavailable', error_code: 'MODEL_UNAVAILABLE', code: 503, retry_after: 2,
    };
    server.wss.on('connection', (socket) => {
      socket.once('message', () => socket.send(JSON.stringify(errorFrame)));
    });
    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));
    const stream = instance.synthesize('retry budget exhausted', {
      maxRetry: 1, retryIntervalMs: 10, timeoutMs: 5000,
    });
    const audio = [];
    for await (const event of stream) audio.push(event);
    expect(audio).toHaveLength(0);
    expect(server.connectionCount).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ statusCode: 503, body: errorFrame });
  });

  it('reports a terminal chunked validation error without retrying', async () => {
    const instance = await setup();
    server.errorFrame = { error: 'invalid text', error_code: 'VALIDATION_ERROR', code: 400 };
    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));
    const stream = instance.synthesize('invalid', {
      maxRetry: 3, retryIntervalMs: 10, timeoutMs: 5000,
    });
    const audio = [];
    for await (const event of stream) audio.push(event);
    expect(audio).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ statusCode: 400, retryable: false });
    expect(server.messages.filter((m) => m.text === 'invalid')).toHaveLength(1);
  });

  it('does not report a chunked cancellation as a terminal API failure', async () => {
    const instance = await setup();
    server.silent = true;
    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));
    const controller = new AbortController();
    const stream = instance.synthesize('cancel this request', {
      maxRetry: 0, retryIntervalMs: 10, timeoutMs: 5000,
    }, controller.signal);
    const consume = (async () => {
      for await (const _ of stream) {
        // drain
      }
    })();
    await expect.poll(() => server.messages.some((m) => m.text === 'cancel this request')).toBe(true);
    controller.abort();
    await consume;
    expect(errors).toHaveLength(0);
  });

  it('keeps a context-scoped error isolated and reuses the healthy connection', async () => {
    const instance = await setup();
    server.silent = true;
    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));
    const streams = ['failed', 'healthy'].map(() => instance.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 10, timeoutMs: 5000 },
    }));
    const audioSamples = [0, 0];
    const consumers = streams.map(async (stream, index) => {
      for await (const event of stream) {
        if (event === SynthesizeStream.END_OF_STREAM) break;
        audioSamples[index]! += event.frame.samplesPerChannel;
      }
    });
    streams[0]!.pushText('failed');
    streams[1]!.pushText('healthy');
    await expect.poll(() => server.messages.filter((m) => m.text).length).toBe(2);
    const failedId = server.messages.find((m) => m.text === 'failed')!.context_id;
    const healthyId = server.messages.find((m) => m.text === 'healthy')!.context_id;
    const [socket] = [...server.wss.clients];
    socket!.send(JSON.stringify({
      context_id: failedId, error: 'invalid text', error_code: 'VALIDATION_ERROR', code: 400,
    }));
    socket!.send(JSON.stringify({
      context_id: healthyId, audio: Buffer.alloc(FRAME_BYTES).toString('base64'),
    }));
    socket!.send(JSON.stringify({ context_id: healthyId, context_closed: true }));
    await Promise.all(consumers);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ statusCode: 400, requestId: failedId, retryable: false });
    expect(audioSamples).toEqual([0, FRAME_BYTES / 2]);
    server.silent = false;
    for await (const _ of instance.synthesize('still healthy')) {
      // drain
    }
    expect(server.connectionCount).toBe(1);
  });

  it('barge-in (stream.close) sends an immediate close_context', async () => {
    const instance = await setup();
    // Many frames so generation is "in flight" when we barge in.
    server.audioFramesPerFlush = 50;

    const stream = instance.stream();
    stream.pushText('Eine sehr lange Ansage');
    stream.flush();

    // Consume a couple of frames, then barge in.
    let received = 0;
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      received += 1;
      if (received >= 2) {
        stream.close();
        break;
      }
    }
    expect(received).toBe(2);

    // The immediate close reaches the server asynchronously.
    await expect
      .poll(() =>
        server.messages.some((m) => m.close_context === true && m.immediate === true),
      )
      .toBe(true);
  });

  it('fails promptly on a server error even while the input channel stays open', async () => {
    const instance = await setup();
    server.errorFrame = {
      error: 'model exploded',
      error_code: 'INTERNAL_ERROR',
      code: 500,
    };

    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));

    const stream = instance.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 10, timeoutMs: 5000 },
    });
    // Flush triggers the error frame, but the input channel is deliberately
    // never ended — simulating an LLM that is still producing tokens. Without
    // input-loop cancellation this would hang until the input closes.
    stream.pushText('boom');
    stream.flush();

    const before = Date.now();
    const events = [];
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      events.push(event);
    }

    expect(Date.now() - before).toBeLessThan(2000);
    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('model exploded');
    stream.close();
  }, 10_000);

  it('rejects the run with APITimeoutError when the server goes silent', async () => {
    const instance = await setup();
    server.silent = true;

    const errors: Error[] = [];
    instance.on('error', (event) => errors.push(event.error));

    const stream = instance.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 10, timeoutMs: 500 },
    });
    stream.pushText('niemand antwortet');
    stream.endInput();

    const events = [];
    for await (const event of stream) {
      if (event === SynthesizeStream.END_OF_STREAM) break;
      events.push(event);
    }

    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.name).toBe('APITimeoutError');
  }, 10_000);
});

describe('dictionary options', () => {
  it('refuses a dictionary selection with no project', () => {
    // The server rejects it, so failing here names the missing field instead of
    // surfacing a wire error on every synthesis.
    expect(
      () => new TTS({ apiKey: 'k', dictionaryIds: [120] }),
    ).toThrow(/projectId/);
  });

});
