/**
 * `/ws/tts/multi` per-context error frames carry `turn_ended`: true when the
 * error ended the context's current turn (no `final` follows), false when the
 * turn stays open. The SDK settles its turn queue from the flag and falls back
 * to its error-code lists only when a frame has no `turn_ended` key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KugelAudio } from './client';
import { ValidationError } from './errors';

type WsListener = (event: { data: string }) => void;
type WsCloseListener = (event: { code: number; reason?: string }) => void;

interface MockWs {
  onmessage: WsListener | null;
  onclose: WsCloseListener | null;
  send: ReturnType<typeof vi.fn>;
}

let mockWs: MockWs;

vi.mock('./websocket', () => ({
  getWebSocket: () =>
    class MockWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: WsListener | null = null;
      onerror: (() => void) | null = null;
      onclose: WsCloseListener | null = null;
      send = vi.fn();
      close = vi.fn();
      ping = vi.fn();

      constructor() {
        mockWs = this as unknown as MockWs;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        }, 0);
      }
    },
}));

function receive(frame: Record<string, unknown>): void {
  mockWs.onmessage?.({ data: JSON.stringify(frame) });
}

const created = { context_created: true, context_id: 'a' };
const final = { final: true, context_id: 'a' };
const audio = {
  audio: Buffer.alloc(200, 1).toString('base64'),
  enc: 'pcm_s16le',
  idx: 0,
  sr: 24000,
  samples: 100,
  context_id: 'a',
};

function scopedError(
  error_code: string,
  turnEnded: boolean | undefined,
  code = error_code === 'VALIDATION_ERROR' ? 400 : 404,
): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    error: `${error_code} from ingress`,
    error_code,
    code,
    context_id: 'a',
    request_id: 'req-1',
  };
  if (turnEnded !== undefined) frame.turn_ended = turnEnded;
  return frame;
}

/** Texts of the non-empty text frames sent on the current socket. */
function sentTexts(): string[] {
  return mockWs.send.mock.calls
    .map((c) => JSON.parse(c[0] as string))
    .filter((f) => typeof f.text === 'string' && f.text.trim() !== '')
    .map((f) => f.text);
}

describe('MultiContextSession turn_ended on scoped error frames', () => {
  let client: KugelAudio;
  let recordFailure: ReturnType<typeof vi.spyOn>;
  let recordSuccess: ReturnType<typeof vi.spyOn>;
  let onError: ReturnType<typeof vi.fn<(error: Error, contextId?: string) => void>>;

  async function connect() {
    const session = client.tts.createMultiContextSession({ defaultVoiceId: 7, language: 'en' });
    const connected = session.connect({ onError });
    await vi.advanceTimersByTimeAsync(1);
    await connected;
    recordSuccess.mockClear();
    return session;
  }

  /** Close with `code`, wait out the replay delay; return the texts the fresh socket replayed. */
  async function restart(code: number): Promise<string[]> {
    const oldWs = mockWs;
    oldWs.onclose?.({ code });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockWs).not.toBe(oldWs);
    return sentTexts();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    client = new KugelAudio({ apiKey: 'test-key-xxx' });
    recordFailure = vi.spyOn(client.diagnostics, 'recordFailure');
    recordSuccess = vi.spyOn(client.diagnostics, 'recordSuccess');
    onError = vi.fn<(error: Error, contextId?: string) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('case 1: an unsupported model/language at runner start on a flush frame ends the turn', async () => {
    const session = await connect();
    session.send('a', 'turn A', true);
    session.send('a', 'turn B', true);
    receive(created);
    // UnsupportedModelLanguageError at runner start on A's flush frame.
    receive(scopedError('VALIDATION_ERROR', true));
    expect(onError).toHaveBeenCalledWith(expect.any(ValidationError), 'a');
    expect(recordFailure).toHaveBeenCalledOnce();

    // B streams; its final ends B, not the already-ended A.
    receive(audio);
    receive(final);
    expect(recordSuccess).toHaveBeenCalledOnce();
    expect(recordFailure).toHaveBeenCalledOnce();
  });

  it('case 2: a bad prosody tag on a non-flush frame keeps the turn open until its final', async () => {
    const session = await connect();
    session.send('a', 'valid prefix', false);
    session.send('a', '<prosody rate="bad">x</prosody>', false);
    session.flush('a');
    session.send('a', 'queued turn two', true);
    receive(created);
    receive(scopedError('VALIDATION_ERROR', false));
    expect(onError).toHaveBeenCalledWith(expect.any(ValidationError), 'a');
    expect(recordFailure).not.toHaveBeenCalled();

    // The later flush still yields A's final; turn two stays queued.
    receive(audio);
    receive(final);
    expect(recordSuccess).toHaveBeenCalledOnce();
    expect(await restart(1012)).toEqual(['queued turn two']);
  });

  it('case 2b: a runner-start failure on a non-flush frame ends the turn at the empty final of its flush', async () => {
    const session = await connect();
    session.send('a', 'turn A', false);
    session.flush('a');
    session.send('a', 'turn B', true);
    receive(created);
    receive(scopedError('VALIDATION_ERROR', false));
    expect(recordFailure).not.toHaveBeenCalled();
    // A's separate flush: no runner, empty final. B stays queued.
    receive(final);
    expect(await restart(1012)).toEqual(['turn B']);
  });

  it('case 3: an error raised by flushing buffered text ends the turn', async () => {
    const session = await connect();
    session.send('a', 'buffered fragment', false);
    session.flush('a');
    session.send('a', 'turn B', true);
    receive(created);
    // Ingress buffered A's text without a reply; runner.tts.flush() then hit
    // VoiceNotFoundError on A's flush frame: NOT_FOUND, no final for A.
    receive(scopedError('NOT_FOUND', true));
    expect(recordFailure).toHaveBeenCalledOnce();

    receive(audio);
    receive(final);
    expect(recordSuccess).toHaveBeenCalledOnce();
    // B completed and A ended: nothing is left to replay.
    expect(await restart(1012)).toEqual([]);
  });

  it.each([1012, 1013])(
    'case 4: after an unsupported model/language error, a %i restart replays no finished turn',
    async (closeCode) => {
      const session = await connect();
      session.send('a', 'turn A', true);
      session.send('a', 'turn B', true);
      session.send('a', 'turn C', true);
      receive(created);
      receive(scopedError('VALIDATION_ERROR', true));
      receive(audio);
      receive(final);
      // A ended by its error, B finished: only C is replayed.
      expect(await restart(closeCode)).toEqual(['turn C']);
    },
  );

  it('case 5: a frame without turn_ended follows the error-code lists', async () => {
    const session = await connect();
    // NOT_FOUND is on the frame-error list: on a flush frame it ends the turn.
    session.send('a', 'turn A', true);
    receive(created);
    receive(scopedError('NOT_FOUND', undefined));
    expect(recordFailure).toHaveBeenCalledOnce();

    // VALIDATION_ERROR is on no list: B stays queued even though the error
    // was on its flush frame. The final that follows is really C's, so the
    // SDK ends B with it and a restart replays the finished C: the gap the
    // flag closes (compare case 4).
    session.send('a', 'turn B', true);
    session.send('a', 'turn C', true);
    receive(scopedError('VALIDATION_ERROR', undefined));
    expect(recordFailure).toHaveBeenCalledOnce();
    receive(audio);
    receive(final);
    expect(await restart(1012)).toEqual(['turn C']);
  });

  it('case 5c: without turn_ended, a NOT_FOUND after buffered text and a flush takes the code-list reading', async () => {
    const session = await connect();
    session.send('a', 'turn A', false);
    session.flush('a');
    session.send('a', 'turn B', true);
    receive(created);
    // Without the flag this NOT_FOUND reads as a runner-start failure on A's
    // text frame: A waits for the empty final of its separate flush.
    receive(scopedError('NOT_FOUND', undefined));
    expect(recordFailure).not.toHaveBeenCalled();
    receive(final);
    expect(recordFailure).toHaveBeenCalledOnce();
    // B has not streamed, so a restart rightly replays it.
    expect(await restart(1012)).toEqual(['turn B']);
    // The same frame can also come from a failed flush of buffered text, which
    // no final follows. Only turn_ended tells the two apart (case 3), so this
    // SDK's release waits for the ingress that sends it.
  });

  it('case 5b: a non-boolean turn_ended is treated as absent', async () => {
    const session = await connect();
    session.send('a', 'turn A', true);
    session.send('a', 'turn B', true);
    receive(created);
    receive({ ...scopedError('VALIDATION_ERROR', undefined), turn_ended: 'true' });
    expect(recordFailure).not.toHaveBeenCalled();
    expect(await restart(1012)).toEqual(['turn A', 'turn B']);
  });
});
