/**
 * An API key reaches the server as an `Authorization` header on every
 * socket (TTS, ASR, enhance), from both BUILT entry points through the real
 * `ws` package, and stays out of the upgrade URL.
 *
 * Built package in a child process against a real local server
 * (`wire/harness.ts`). Requires `npm run build` first.
 */

import { describe, expect, it } from 'vitest';

import { API_KEY, runChild, startWireServer } from './wire/harness';

const SOCKETS = ['stream', 'stream_unpooled', 'session', 'multi', 'asr', 'enhance', 'enhance_session'] as const;

describe.concurrent('API key on the wire', () => {
  for (const entry of ['mjs', 'cjs'] as const) {
    it.each([false, true])(`${entry}: every upgrade sends the key in a header (isMasterKey=%s)`, async (isMasterKey) => {
      const server = await startWireServer('accept');
      try {
        const run = await runChild({
          entry,
          apiUrl: server.url,
          isMasterKey,
          telemetry: false,
          calls: SOCKETS.map((kind) => ({ kind, text: 'Hallo' })),
        });
        expect(run.exitCode).toBe(0);
        const paths = server.upgrades.map((u) => new URL(u.url, server.url).pathname);
        expect(new Set(paths)).toEqual(
          new Set(['/ws/tts', '/ws/tts/stream', '/ws/tts/multi', '/v1/audio/transcriptions/stream', '/v1/audio/enhance/stream']),
        );
        for (const upgrade of server.upgrades) {
          expect(upgrade.url).not.toContain(API_KEY);
          expect(upgrade.headers.authorization).toBe(`Bearer ${API_KEY}`);
        }
      } finally {
        await server.close();
      }
    });
  }

});
