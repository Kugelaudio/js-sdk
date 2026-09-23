/**
 * Wire-test child: drives the BUILT package (`dist/index.mjs` or
 * `dist/index.js`) through one scenario, then (by default) closes the client
 * and lets the process exit on its own. Its stdout carries only `RESULT`,
 * `CLOSED` and `ENDED` lines, so anything else the SDK prints is visible to
 * the parent.
 *
 * Usage: node [--import ./preload.mjs] child.mjs '<scenario json>'
 *   { entry: 'mjs'|'cjs', apiUrl, apiKey, telemetry?, calls: [{kind, text?}],
 *     (kinds: `CallKind` in harness.ts)
 *     close?: boolean (default true), crash?: boolean }
 *
 * `close: false` ends the script without closing (the exit flush's case);
 * `crash: true` then leaves an unhandled rejection behind.
 */
import { createRequire } from 'node:module';

const scenario = JSON.parse(process.argv[2]);
const sdk =
  scenario.entry === 'cjs'
    ? createRequire(import.meta.url)('../../dist/index.js')
    : await import('../../dist/index.mjs');

const client = new sdk.KugelAudio({
  apiKey: scenario.apiKey,
  apiUrl: scenario.apiUrl,
  ...(scenario.telemetry !== undefined && { telemetry: scenario.telemetry }),
});

const results = [];
for (const call of scenario.calls) {
  try {
    if (call.kind === 'models') await client.models.list();
    else if (call.kind === 'generate') {
      await client.tts.generate({ text: call.text, language: 'en', voiceId: 1 });
    }
    else if (call.kind === 'stream' || call.kind === 'stream_unpooled') {
      const pooled = call.kind === 'stream';
      await client.tts.stream({ text: call.text, language: 'en', voiceId: 1 }, {}, pooled);
    } else if (call.kind === 'readable') {
      const readable = client.tts.toReadable({ text: call.text, language: 'en', voiceId: 1 });
      for await (const chunk of readable) void chunk;
    } else if (call.kind === 'session') {
      await client.tts.streamingSession({ voiceId: 1, language: 'en' }, {}).connect();
    } else if (call.kind === 'multi') {
      await client.tts.createMultiContextSession({ defaultVoiceId: 1 }).connect({});
    } else throw new Error(`unknown call ${call.kind}`);
    results.push({ ok: true });
  } catch (error) {
    results.push({
      ok: false,
      cls: error?.name ?? null,
      statusCode: error?.statusCode ?? null,
      requestId: error?.requestId ?? null,
    });
  }
}
process.stdout.write(`RESULT ${JSON.stringify(results)}\n`);

if (scenario.close === false) {
  process.stdout.write(`ENDED ${Date.now()}\n`);
  if (scenario.crash) void Promise.reject(new Error('uncaught-in-app'));
} else {
  const started = performance.now();
  client.close();
  process.stdout.write(`CLOSED ${(performance.now() - started).toFixed(1)} ${Date.now()}\n`);
}
