/**
 * Diagnostics on the wire: the BUILT package (dist/index.mjs and
 * dist/index.js) in a child node process against a real local HTTP server,
 * with no fetch or ws mocks. See `wire/harness.ts`.
 *
 * Contract: `services/ingress/docs/sdk-diagnostics-contract.md` ("Enablement",
 * "Wire format", "Delivery"). Every child must exit on its own within 1.5 s of
 * `client.close()` and print nothing beyond its own RESULT/CLOSED lines.
 *
 * Requires `npm run build` first (CI's js-sdk unit builds before testing).
 */

import { describe, expect, it } from 'vitest';

import {
  API_KEY,
  API_REQUEST_ID,
  UPGRADE_REQUEST_ID,
  closedPort,
  recordsOf,
  runChild,
  startWireServer,
  type ChildRun,
  type DiagnosticsMode,
  type WireServer,
} from './wire/harness';

/**
 * Run `body` against its own server, closed when it ends. Tests here run
 * concurrently, so a shared afterEach would tear down other tests' servers.
 */
async function withServer<T>(
  mode: DiagnosticsMode,
  body: (s: WireServer) => Promise<T>,
): Promise<T> {
  const s = await startWireServer(mode);
  try {
    return await body(s);
  } finally {
    await s.close();
  }
}

/** The hosted name the preload resolves to the local server. */
function hostedUrl(s: WireServer): string {
  return `http://probe.kugelaudio.com:${s.port}`;
}

/** Nothing printed, close() instant, process gone within 1.5 s. */
function expectQuietPromptExit(run: ChildRun): void {
  expect(run.strayOutput).toEqual([]);
  expect(run.exitCode).toBe(0);
  expect(run.closeCallMs).toBeLessThan(50);
  expect(run.exitAfterCloseMs).toBeLessThan(1_500);
}

const MODELS_500 = { ok: false, cls: 'KugelAudioError', statusCode: 500, requestId: API_REQUEST_ID };
const THREE_FAILURES = [{ kind: 'models' }, { kind: 'models' }, { kind: 'models' }] as const;

describe.concurrent('refused WS upgrade in both builds (ESM used to fall back to native WebSocket)', () => {
  for (const entry of ['mjs', 'cjs'] as const) {
    it(`dist/index.${entry === 'mjs' ? 'mjs' : 'js'} raises AuthenticationError with the x-request-id`, async () => {
      await withServer('accept', async (s) => {
        const run = await runChild({
          entry,
          apiUrl: s.url,
          telemetry: false,
          calls: [{ kind: 'stream', text: 'Hallo' }],
        });
        expect(run.results).toEqual([
          { ok: false, cls: 'AuthenticationError', statusCode: 401, requestId: UPGRADE_REQUEST_ID },
        ]);
        expectQuietPromptExit(run);
      });
    });
  }
});

describe.concurrent('opt-out matrix on the wire', () => {
  it('telemetry: false sends nothing', async () => {
    await withServer('accept', async (s) => {
      const run = await runChild({ apiUrl: hostedUrl(s), telemetry: false, calls: [...THREE_FAILURES] });
      expect(run.results).toEqual([MODELS_500, MODELS_500, MODELS_500]);
      expect(s.posts).toHaveLength(0);
      expectQuietPromptExit(run);
    });
  });

  it('a custom URL with the option unset sends nothing', async () => {
    await withServer('accept', async (s) => {
      const run = await runChild({ apiUrl: s.url, calls: [...THREE_FAILURES] });
      expect(s.posts).toHaveLength(0);
      expectQuietPromptExit(run);
    });
  });

  it('KUGELAUDIO_TELEMETRY=0 beats telemetry: true', async () => {
    await withServer('accept', async (s) => {
      const run = await runChild({ apiUrl: s.url, telemetry: true, env: '0', calls: [...THREE_FAILURES] });
      expect(s.posts).toHaveLength(0);
      expectQuietPromptExit(run);
    });
  });

  it('KUGELAUDIO_TELEMETRY=1 beats telemetry: false', async () => {
    await withServer('accept', async (s) => {
      const run = await runChild({ apiUrl: s.url, telemetry: false, env: '1', calls: [...THREE_FAILURES] });
      expect(s.posts.length).toBeGreaterThan(0);
      expect(recordsOf(s.posts).map((r) => r.body)).toEqual([
        'request_failed', 'request_failed', 'request_failed', 'sdk_stats',
      ]);
      expectQuietPromptExit(run);
    });
  });

  it('a hosted URL is on by default', async () => {
    await withServer('accept', async (s) => {
      const run = await runChild({ apiUrl: hostedUrl(s), calls: [...THREE_FAILURES] });
      const records = recordsOf(s.posts);
      expect(records.map((r) => r.body)).toEqual([
        'request_failed', 'request_failed', 'request_failed', 'sdk_stats',
      ]);
      expect(records[0]!['kugel.endpoint_kind']).toBe('hosted');
      expectQuietPromptExit(run);
    });
  });

  it('KUGELAUDIO_TELEMETRY=0 turns the hosted default off', async () => {
    await withServer('accept', async (s) => {
      const run = await runChild({ apiUrl: hostedUrl(s), env: '0', calls: [...THREE_FAILURES] });
      expect(s.posts).toHaveLength(0);
      expectQuietPromptExit(run);
    });
  });
});

describe.concurrent('payload on the wire', () => {
  it('is JSON with the auth header, at most 8 records per POST, and no input text', async () => {
    await withServer('accept', async (s) => {
      const secretText = 'GEHEIMER_EINGABETEXT_4711';
      const calls = [
        ...Array.from({ length: 10 }, () => ({ kind: 'models' as const })),
        { kind: 'stream' as const, text: secretText },
      ];
      const run = await runChild({ apiUrl: hostedUrl(s), calls });

      expect(run.results.at(-1)).toMatchObject({ cls: 'AuthenticationError', requestId: UPGRADE_REQUEST_ID });
      expect(s.posts.length).toBeGreaterThanOrEqual(2);
      for (const post of s.posts) {
        expect(post.headers['content-type']).toBe('application/json');
        expect(post.headers['x-api-key']).toBe(API_KEY);
        const records = JSON.parse(post.body).resourceLogs[0].scopeLogs[0].logRecords;
        expect(records.length).toBeLessThanOrEqual(8);
        expect(post.body).not.toContain(secretText);
        expect(post.body).not.toContain(API_KEY);
      }
      const records = recordsOf(s.posts);
      // 10 request_failed + 1 connection_failed + sdk_stats, none lost.
      expect(records).toHaveLength(12);
      const handshake = records.find((r) => r.body === 'connection_failed');
      expect(handshake?.['kugel.server_request_id']).toBe(UPGRADE_REQUEST_ID);
      expectQuietPromptExit(run);
    });
  });
});

describe.concurrent('diagnostics endpoint failure modes: the caller sees only its own error', () => {
  it('404 three times retires the reporter: no fourth POST', async () => {
    await withServer('404', async (s) => {
      const calls = Array.from({ length: 40 }, () => ({ kind: 'models' as const }));
      const run = await runChild({ apiUrl: s.url, telemetry: true, calls });
      expect(run.results).toEqual(calls.map(() => MODELS_500));
      expect(s.posts).toHaveLength(3);
      expectQuietPromptExit(run);
    });
  });

  for (const mode of ['500', '413', 'hang'] as const) {
    it(`diagnostics route ${mode === 'hang' ? 'never answers' : `answers ${mode}`}`, async () => {
      await withServer(mode, async (s) => {
        const run = await runChild({ apiUrl: s.url, telemetry: true, calls: [...THREE_FAILURES] });
        expect(run.results).toEqual([MODELS_500, MODELS_500, MODELS_500]);
        expect(s.posts.length).toBeGreaterThan(0);
        if (mode === '413') {
          // Never retried: every POST carried a different batch.
          expect(new Set(s.posts.map((p) => p.body)).size).toBe(s.posts.length);
        }
        expectQuietPromptExit(run);
      });
    });
  }

  it('connection refused', async () => {
    const port = await closedPort();
    const run = await runChild({
      apiUrl: `http://127.0.0.1:${port}`,
      telemetry: true,
      calls: [{ kind: 'models' }],
    });
    expect(run.results).toEqual([
      { ok: false, cls: 'ConnectionError', statusCode: 503, requestId: null },
    ]);
    expectQuietPromptExit(run);
  });

  it('unresolvable host', async () => {
    const run = await runChild({
      apiUrl: 'http://api.nowhere.invalid',
      telemetry: true,
      calls: [{ kind: 'models' }],
    });
    expect(run.results).toEqual([
      { ok: false, cls: 'ConnectionError', statusCode: 503, requestId: null },
    ]);
    expectQuietPromptExit(run);
  });
});
