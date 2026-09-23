/**
 * `toReadable()` from both BUILT entry points: it returns a Node `Readable`
 * synchronously and a refused upgrade destroys it with the typed error.
 * The ESM build used to throw `Dynamic require of "stream" is not supported`
 * from esbuild's `__require` shim on every Node version.
 *
 * Built package in a child process against a real local server
 * (`wire/harness.ts`). Requires `npm run build` first.
 */

import { describe, expect, it } from 'vitest';

import { UPGRADE_REQUEST_ID, runChild, startWireServer } from './wire/harness';

const AUTH_401 = { ok: false, cls: 'AuthenticationError', statusCode: 401, requestId: UPGRADE_REQUEST_ID };

describe.concurrent('toReadable() from the built package', () => {
  for (const entry of ['mjs', 'cjs'] as const) {
    it(`${entry}: the stream ends in AuthenticationError on a refused upgrade`, async () => {
      const server = await startWireServer('accept');
      try {
        const run = await runChild({
          entry,
          apiUrl: server.url,
          telemetry: false,
          calls: [{ kind: 'readable', text: 'Hallo' }],
        });
        expect(run.results).toEqual([AUTH_401]);
        expect(run.strayOutput).toEqual([]);
        expect(run.exitCode).toBe(0);
      } finally {
        await server.close();
      }
    });
  }
});
