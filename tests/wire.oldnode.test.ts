/**
 * The ESM build on Node without `process.getBuiltinModule` (18.x, 20.0-20.15,
 * 22.0-22.2): every connect path must still open its socket through `ws`, so a
 * refused upgrade surfaces as `AuthenticationError` carrying the upgrade's
 * `x-request-id`. Before the async `import('ws')` fallback, Node 18/20 threw
 * "WebSocket not available" and 22.0-22.2 fell onto the native WebSocket,
 * which loses the status and the request id.
 *
 * Always on: the current Node with `getBuiltinModule` deleted by a preload.
 * Opt-in: real old Node binaries, fetched through `npx -y node@<version>`
 * (a download, so kept out of the default run):
 *
 *   KUGELAUDIO_OLD_NODE=18.20.4,20.10.0,22.2.0 npx vitest run tests/wire.oldnode.test.ts
 *
 * Built package in a child process against a real local server
 * (`wire/harness.ts`). Requires `npm run build` first.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UPGRADE_REQUEST_ID, runChild, startWireServer, type CallKind } from './wire/harness';

const NO_BUILTIN_MODULE = join(__dirname, 'wire', 'no-builtin-module.mjs');
const KINDS: CallKind[] = ['generate', 'stream', 'stream_unpooled', 'session', 'multi'];
const CALLS = KINDS.map((kind) => ({ kind, text: 'Hallo' }));
const AUTH_401 = { ok: false, cls: 'AuthenticationError', statusCode: 401, requestId: UPGRADE_REQUEST_ID };

const OLD_NODE = (process.env.KUGELAUDIO_OLD_NODE ?? '').split(',').map((v) => v.trim()).filter(Boolean);

async function refusedUpgradeResults(options: { node?: string; preloads?: string[] }) {
  const server = await startWireServer('accept');
  try {
    return await runChild({ apiUrl: server.url, telemetry: false, calls: CALLS, ...options });
  } finally {
    await server.close();
  }
}

describe('ESM build without process.getBuiltinModule', () => {
  it('uses `ws` on every connect path (getBuiltinModule deleted by a preload)', async () => {
    const run = await refusedUpgradeResults({ preloads: [NO_BUILTIN_MODULE] });
    expect(run.results).toEqual(KINDS.map(() => AUTH_401));
    expect(run.strayOutput).toEqual([]);
    expect(run.exitCode).toBe(0);
  });

  it.skipIf(OLD_NODE.length === 0)(
    'uses `ws` on real old Node binaries (opt-in: KUGELAUDIO_OLD_NODE=18.20.4,20.10.0,22.2.0)',
    async () => {
      for (const version of OLD_NODE) {
        const node = execFileSync('npx', ['-y', `node@${version}`, '-p', 'process.execPath'], {
          encoding: 'utf8',
          timeout: 120_000,
        }).trim();
        const run = await refusedUpgradeResults({ node });
        expect({ version, results: run.results }).toEqual({ version, results: KINDS.map(() => AUTH_401) });
        expect({ version, stray: run.strayOutput }).toEqual({ version, stray: [] });
      }
    },
    600_000,
  );
});
