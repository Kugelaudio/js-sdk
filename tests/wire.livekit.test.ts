/**
 * LiveKit plugin opt-out matrix on the wire: a real local server refuses the
 * `/ws/tts/multi` upgrade with 401 (so every synthesis fails and would be
 * reported) and records every `POST /v1/sdk-diagnostics`. No fetch or ws
 * mocks. The plugin runs in-process: it needs `@livekit/agents`, whose
 * startup cost a child per case would multiply.
 *
 * Contract "Enablement": env beats option, option beats the hosted default
 * (a 127.0.0.1 base URL is a custom endpoint, so off by default).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '@livekit/agents';

import { TTS } from '../src/livekit/tts';
import { startWireServer, type WireServer } from './wire/harness';

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** One failing synthesis, then close(): returns the POSTs the server saw. */
async function synthesizeAndClose(env: string, telemetry?: boolean): Promise<number> {
  vi.stubEnv('KUGELAUDIO_TELEMETRY', env);
  const server: WireServer = await startWireServer('accept');
  try {
    const instance = new TTS({
      apiKey: 'test-key',
      baseURL: server.url,
      language: 'en',
      ...(telemetry !== undefined && { telemetry }),
    });
    instance.on('error', () => {});
    for await (const _ of instance.synthesize('Hallo', { maxRetry: 0, retryIntervalMs: 10, timeoutMs: 5000 })) {
      // drain
    }
    await instance.close();
    return server.posts.length;
  } finally {
    await server.close();
  }
}

describe('LiveKit telemetry opt-out on the wire', () => {
  it('telemetry: false sends nothing', async () => {
    expect(await synthesizeAndClose('', false)).toBe(0);
  });

  it('a custom base URL with the option unset sends nothing', async () => {
    expect(await synthesizeAndClose('')).toBe(0);
  });

  it('KUGELAUDIO_TELEMETRY=0 beats telemetry: true', async () => {
    expect(await synthesizeAndClose('0', true)).toBe(0);
  });

  it('KUGELAUDIO_TELEMETRY=1 beats telemetry: false', async () => {
    expect(await synthesizeAndClose('1', false)).toBeGreaterThan(0);
  });

  it('telemetry: true on a custom base URL sends', async () => {
    expect(await synthesizeAndClose('', true)).toBeGreaterThan(0);
  });
});
