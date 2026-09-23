/**
 * Real-socket harness for the diagnostics wire tests: a local HTTP server on
 * port 0 that plays the KugelAudio API (failing calls, refused WS upgrades)
 * and records every `POST /v1/sdk-diagnostics`, plus a runner that drives the
 * built package in a child node process (`child.mjs`).
 *
 * No fetch or ws mocks anywhere: requests cross a real TCP socket.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGE_ROOT = join(__dirname, '..', '..');
const CHILD = join(__dirname, 'child.mjs');
const PRELOAD = join(__dirname, 'preload.mjs');

/** Request id the fake API puts on every failure it returns. */
export const API_REQUEST_ID = 'req-wire-api';
/** Request id on the refused WS upgrade. */
export const UPGRADE_REQUEST_ID = 'req-wire-401';

export type DiagnosticsMode = 'accept' | '404' | '500' | '413' | 'hang';

export interface DiagnosticsPost {
  headers: IncomingHttpHeaders;
  body: string;
}

export interface WireServer {
  port: number;
  url: string;
  posts: DiagnosticsPost[];
  close(): Promise<void>;
}

/**
 * The fake API: `GET /v1/models` fails with 500, every WS upgrade is refused
 * with 401 + `x-request-id`, and `/v1/sdk-diagnostics` behaves per `mode`.
 */
export async function startWireServer(mode: DiagnosticsMode = 'accept'): Promise<WireServer> {
  const posts: DiagnosticsPost[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/sdk-diagnostics') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        posts.push({ headers: req.headers, body });
        if (mode === 'hang') return; // never answered
        const status = mode === 'accept' ? 202 : Number(mode);
        res.writeHead(status).end();
      });
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json', 'x-request-id': API_REQUEST_ID });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  server.on('upgrade', (_req, socket) => {
    socket.end(
      'HTTP/1.1 401 Unauthorized\r\n' +
        `x-request-id: ${UPGRADE_REQUEST_ID}\r\n` +
        'Content-Length: 0\r\nConnection: close\r\n\r\n',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    posts,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port nothing listens on: bound once, then released. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * One SDK call in the child. `stream` pools its socket, `stream_unpooled`
 * does not; `readable` drains `toReadable()`; `session` and `multi` connect a
 * streaming / multi-context session.
 */
export type CallKind =
  | 'models'
  | 'generate'
  | 'stream'
  | 'stream_unpooled'
  | 'readable'
  | 'session'
  | 'multi';

export interface Scenario {
  entry?: 'mjs' | 'cjs';
  apiUrl: string;
  apiKey?: string;
  telemetry?: boolean;
  calls: { kind: CallKind; text?: string }[];
  /** Close the client at the end (default); `false` lets the script just end. */
  close?: boolean;
  /** With `close: false`: leave an unhandled rejection behind. */
  crash?: boolean;
  /** `KUGELAUDIO_TELEMETRY` for the child; unset when omitted. */
  env?: string;
  /** Node executable for the child; this process's own when omitted. */
  node?: string;
  /** Extra `--import` preloads, after the DNS one. */
  preloads?: string[];
}

export interface CallResult {
  ok: boolean;
  cls?: string | null;
  statusCode?: number | null;
  requestId?: string | null;
}

export interface ChildRun {
  results: CallResult[];
  /** Wall time of the synchronous `client.close()` call, ms. */
  closeCallMs: number;
  /** From `client.close()` returning to the process exiting, ms. */
  exitAfterCloseMs: number;
  /** From the unclosed script's last line to the process exiting, ms. */
  exitAfterEndMs: number;
  exitCode: number | null;
  /** stdout lines other than RESULT/CLOSED/ENDED, and every stderr line. */
  strayOutput: string[];
  stderr: string;
}

export const API_KEY = 'sk_wire_secret_key_0042';

/** Run one scenario against the BUILT package in a fresh node process. */
export async function runChild(scenario: Scenario): Promise<ChildRun> {
  for (const file of ['dist/index.mjs', 'dist/index.js']) {
    if (!existsSync(join(PACKAGE_ROOT, file))) {
      throw new Error(`${file} missing: run \`npm run build\` before the wire tests`);
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.KUGELAUDIO_TELEMETRY;
  delete env.NODE_OPTIONS;
  if (scenario.env !== undefined) env.KUGELAUDIO_TELEMETRY = scenario.env;

  const { node = process.execPath, preloads = [], ...rest } = scenario;
  const payload = JSON.stringify({ entry: 'mjs', apiKey: API_KEY, ...rest });
  const imports = [PRELOAD, ...preloads].flatMap((file) => ['--import', pathToFileURL(file).href]);
  const child = spawn(node, [...imports, CHILD, payload], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });

  const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  const exitedAt = Date.now();
  clearTimeout(killer);
  await new Promise((resolve) => setImmediate(resolve)); // drain the pipes

  const lines = stdout.split('\n').filter(Boolean);
  const result = lines.find((l) => l.startsWith('RESULT '));
  const closed = lines.find((l) => l.startsWith('CLOSED '))?.split(' ');
  const ended = lines.find((l) => l.startsWith('ENDED '))?.split(' ');
  return {
    results: result ? JSON.parse(result.slice('RESULT '.length)) : [],
    closeCallMs: closed ? Number(closed[1]) : Number.NaN,
    exitAfterCloseMs: closed ? exitedAt - Number(closed[2]) : Number.NaN,
    exitAfterEndMs: ended ? exitedAt - Number(ended[1]) : Number.NaN,
    exitCode,
    strayOutput: [
      ...lines.filter((l) => !/^(RESULT|CLOSED|ENDED) /.test(l)),
      ...stderr.split('\n').filter(Boolean),
    ],
    stderr,
  };
}

/** Every log record across the recorded POSTs, as flat attribute maps. */
export function recordsOf(posts: DiagnosticsPost[]): Record<string, string>[] {
  return posts.flatMap((post) =>
    JSON.parse(post.body).resourceLogs[0].scopeLogs[0].logRecords.map(
      (record: { body: { stringValue: string }; attributes: { key: string; value: { stringValue?: string; intValue?: string } }[] }) => {
        const attrs: Record<string, string> = { body: record.body.stringValue };
        for (const kv of record.attributes) attrs[kv.key] = kv.value.stringValue ?? kv.value.intValue ?? '';
        return attrs;
      },
    ),
  );
}
