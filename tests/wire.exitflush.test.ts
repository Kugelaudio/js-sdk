/**
 * Exit flush on the wire (contract "Delivery", Exit flush bullet in
 * `services/ingress/docs/sdk-diagnostics-contract.md`): a script that catches
 * an SDK error but never closes the client still delivers the report when
 * Node exits, within 1 s; nothing queued means no delay; `close()` makes the
 * hook a no-op; a hard crash loses the report, silently.
 *
 * Built package in a child process against a real local server
 * (`wire/harness.ts`). Requires `npm run build` first.
 */

import { describe, expect, it } from 'vitest';

import {
  UPGRADE_REQUEST_ID,
  recordsOf,
  runChild,
  startWireServer,
  type DiagnosticsMode,
  type WireServer,
} from './wire/harness';

async function withServer<T>(mode: DiagnosticsMode, body: (s: WireServer) => Promise<T>): Promise<T> {
  const s = await startWireServer(mode);
  try {
    return await body(s);
  } finally {
    await s.close();
  }
}

const FAILING_GENERATE = [{ kind: 'generate' as const, text: 'Hallo' }];
const AUTH_401 = { ok: false, cls: 'AuthenticationError', statusCode: 401, requestId: UPGRADE_REQUEST_ID };

describe.concurrent('exit flush for a client that was never closed', () => {
  it('delivers the caught failure on natural exit, at most ~1.1 s later than telemetry off', async () => {
    await withServer('accept', async (s) => {
      const off = await runChild({ apiUrl: s.url, telemetry: false, close: false, calls: FAILING_GENERATE });
      expect(s.posts).toHaveLength(0);
      const on = await runChild({ apiUrl: s.url, telemetry: true, close: false, calls: FAILING_GENERATE });

      expect(on.results).toEqual([AUTH_401]);
      const records = recordsOf(s.posts);
      expect(records.map((r) => r.body)).toEqual(['connection_failed']);
      expect(records[0]!['kugel.operation']).toBe('generate');
      expect(records[0]!['kugel.server_request_id']).toBe(UPGRADE_REQUEST_ID);
      expect(on.exitAfterEndMs - off.exitAfterEndMs).toBeLessThanOrEqual(1_100);
      expect(on.strayOutput).toEqual([]);
      expect(on.exitCode).toBe(0);
    });
  });

  it('adds no exit delay when nothing is queued', async () => {
    await withServer('accept', async (s) => {
      // Relative to a telemetry-off child in the same test, so a loaded
      // runner slows both sides alike; a real exit flush would add ~1 s.
      const off = await runChild({ apiUrl: s.url, telemetry: false, close: false, calls: [] });
      const run = await runChild({ apiUrl: s.url, telemetry: true, close: false, calls: [] });
      expect(s.posts).toHaveLength(0);
      expect(run.exitAfterEndMs - off.exitAfterEndMs).toBeLessThanOrEqual(400);
      expect(run.strayOutput).toEqual([]);
      expect(run.exitCode).toBe(0);
    });
  });

  it('waits at most ~1.1 s for a diagnostics endpoint that never answers, then exits', async () => {
    await withServer('hang', async (s) => {
      const run = await runChild({ apiUrl: s.url, telemetry: true, close: false, calls: FAILING_GENERATE });
      expect(run.results).toEqual([AUTH_401]);
      expect(s.posts).toHaveLength(1);
      expect(run.exitAfterEndMs).toBeGreaterThanOrEqual(900);
      expect(run.exitAfterEndMs).toBeLessThan(1_600);
      expect(run.strayOutput).toEqual([]);
      expect(run.exitCode).toBe(0);
    });
  });

  it('is a no-op after close(): exactly one POST, the one close() sent', async () => {
    await withServer('accept', async (s) => {
      const run = await runChild({ apiUrl: s.url, telemetry: true, calls: FAILING_GENERATE });
      expect(s.posts).toHaveLength(1);
      expect(recordsOf(s.posts).map((r) => r.body)).toEqual(['connection_failed', 'sdk_stats']);
      expect(run.strayOutput).toEqual([]);
      expect(run.exitAfterCloseMs).toBeLessThan(1_500);
    });
  });

  it('loses the report on a hard crash, and adds nothing to Node\'s own error output', async () => {
    // Accepted by the contract: an unhandled rejection kills Node before
    // `beforeExit`, so no async work can run. What must hold is that the
    // crash output is Node's alone.
    await withServer('accept', async (s) => {
      const run = await runChild({
        apiUrl: s.url,
        telemetry: true,
        close: false,
        crash: true,
        calls: FAILING_GENERATE,
      });
      expect(run.results).toEqual([AUTH_401]);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('uncaught-in-app');
      expect(run.stderr).not.toMatch(/diagnostic|telemetry|sdk_stats|Warning:/i);
      expect(s.posts).toHaveLength(0);
    });
  });
});
