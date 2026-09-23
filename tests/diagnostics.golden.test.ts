/**
 * Golden diagnostics batch (contract "Golden batches" in
 * `services/ingress/docs/sdk-diagnostics-contract.md`).
 *
 * `fixtures/diagnostics_golden_batch.json` is this SDK's own encoder output
 * for fixed ids and timestamps: one record per event type, together covering
 * every allowlisted attribute. The ingress contract test
 * (`services/ingress/tests/unit/test_sdk_diagnostics_contract.py`) checks the
 * same file against the server allowlist, so encoder drift fails CI twice.
 *
 * Regenerate after an intended encoder change, then commit the file:
 *
 *   UPDATE_GOLDEN=1 npx vitest run tests/diagnostics.golden.test.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALLOWLISTED_ATTRIBUTES,
  buildLogRecord,
  encodeOtlpPayload,
  type DiagnosticsAttributes,
  type DiagnosticsEventName,
  type RecordIdentity,
} from '../src/diagnosticsWire';

const FIXTURE = join(__dirname, 'fixtures', 'diagnostics_golden_batch.json');

/** 2026-01-01T00:00:00Z plus `i` seconds, in nanoseconds. */
function identity(i: number): RecordIdentity {
  return {
    eventId: `${i}`.padStart(32, 'e'),
    timeUnixNano: String((1_767_225_600n + BigInt(i)) * 1_000_000_000n),
    fallbackOperationId: '5e55105e55105e55105e55105e55105e',
    sdkVersion: '1.0.0',
    runtime: 'node/20.1.0',
    integration: 'livekit',
    endpointKind: 'hosted',
  };
}

const EVENTS: [DiagnosticsEventName, DiagnosticsAttributes][] = [
  ['connection_failed', {
    'kugel.operation_id': '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c01',
    'kugel.operation': 'stream',
    'kugel.transport': 'websocket',
    'kugel.failure_stage': 'handshake',
    'kugel.error_type': 'AuthenticationError',
    'kugel.error_code': 'UNAUTHORIZED',
    'kugel.http_status': 401,
    'kugel.server_request_id': '8f14e45fceea167a5a36dedd4bea2543',
    'kugel.elapsed_ms': 212,
    'kugel.audio_chunks': 0,
    'kugel.audio_bytes': 0,
    'kugel.retry_count': 0,
    'kugel.outcome': 'failed',
  }],
  ['request_failed', {
    'kugel.operation_id': '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c02',
    'kugel.operation': 'voices',
    'kugel.transport': 'http',
    'kugel.failure_stage': 'sending_request',
    'kugel.error_type': 'RateLimitError',
    'kugel.error_code': 'RATE_LIMITED',
    'kugel.http_status': 429,
    'kugel.server_request_id': 'c9f0f895fb98ab9159f51fd0297e236d',
    'kugel.elapsed_ms': 87,
    'kugel.audio_chunks': 0,
    'kugel.audio_bytes': 0,
    'kugel.retry_count': 0,
    'kugel.outcome': 'failed',
  }],
  ['stream_interrupted', {
    'kugel.operation_id': '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c03',
    'kugel.operation': 'multi_context',
    'kugel.transport': 'websocket',
    'kugel.failure_stage': 'receiving_audio',
    'kugel.error_type': 'ConnectionError',
    'kugel.ws_close_code': 1006,
    'kugel.server_request_id': '45c48cce2e2d7fbdea1afc51c7c6ad26',
    'kugel.elapsed_ms': 1834,
    'kugel.audio_chunks': 12,
    'kugel.audio_bytes': 115200,
    'kugel.retry_count': 0,
    'kugel.outcome': 'failed',
  }],
  ['retry_exhausted', {
    'kugel.operation_id': '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c04',
    'kugel.operation': 'stream_session',
    'kugel.transport': 'websocket',
    'kugel.failure_stage': 'connecting',
    'kugel.error_type': 'ServerRestartingError',
    'kugel.ws_close_code': 1012,
    'kugel.elapsed_ms': 2410,
    'kugel.audio_chunks': 0,
    'kugel.audio_bytes': 0,
    'kugel.retry_count': 1,
    'kugel.outcome': 'failed',
  }],
  ['sdk_stats', {
    'kugel.success_count': 41,
    'kugel.failure_count': 4,
    'kugel.cancelled_count': 3,
  }],
];

function encodeGoldenBatch(): string {
  const records = EVENTS.map(([event, attributes], i) =>
    buildLogRecord(event, attributes, identity(i + 1)),
  );
  // Pretty-printed for review; key order is exactly the encoder's.
  return `${JSON.stringify(JSON.parse(encodeOtlpPayload(records, '1.0.0')), null, 2)}\n`;
}

describe('golden diagnostics batch', () => {
  it('is reproduced exactly by the encoder', () => {
    const encoded = encodeGoldenBatch();
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(FIXTURE, encoded);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(encoded);
  });

  it('has one record per event type and covers every allowlisted attribute', () => {
    const batch = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const records = batch.resourceLogs[0].scopeLogs[0].logRecords as {
      body: { stringValue: string };
      attributes: { key: string }[];
    }[];
    expect(records.map((r) => r.body.stringValue)).toEqual([
      'connection_failed',
      'request_failed',
      'stream_interrupted',
      'retry_exhausted',
      'sdk_stats',
    ]);
    const covered = new Set(records.flatMap((r) => r.attributes.map((a) => a.key)));
    expect([...ALLOWLISTED_ATTRIBUTES].filter((key) => !covered.has(key))).toEqual([]);
    expect(ALLOWLISTED_ATTRIBUTES).toHaveLength(24);
  });
});
