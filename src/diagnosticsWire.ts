/**
 * Diagnostics wire format: the attribute allowlist and the OTLP/HTTP JSON
 * encoding of one batch.
 *
 * Normative source: `services/ingress/docs/sdk-diagnostics-contract.md` (v3).
 * The server allowlist in `services/ingress/src/ingress/diagnostics.py` is the
 * source of truth; `tests/fixtures/diagnostics_golden_batch.json` is this
 * encoder's committed output, checked against the server by the ingress
 * contract test. Do not add an attribute without changing all three SDKs.
 *
 * Everything here is pure: no clock, no randomness, no I/O. The reporter in
 * `diagnostics.ts` supplies ids and timestamps, which is what lets the golden
 * batch be reproduced byte for byte.
 */

const SERVICE_NAME = 'kugelaudio-sdk';
const TELEMETRY_LANGUAGE = 'nodejs';
const SCOPE_NAME = 'kugelaudio.diagnostics';
const SCOPE_VERSION = '1';
const SDK_NAME = 'js';

const SEVERITY_ERROR = { number: 17, text: 'ERROR' } as const;
const SEVERITY_INFO = { number: 9, text: 'INFO' } as const;

/** Diagnostics event names (`kugel.event`). */
export type DiagnosticsEventName =
  | 'connection_failed'
  | 'request_failed'
  | 'stream_interrupted'
  | 'retry_exhausted'
  | 'sdk_stats';

/** Operations that can be reported (`kugel.operation`). */
export type DiagnosticsOperationName =
  | 'generate'
  | 'stream'
  | 'stream_session'
  | 'multi_context'
  | 'transcribe'
  | 'voices'
  | 'dictionaries'
  | 'models';

/** Transport carrying the failed operation (`kugel.transport`). */
export type DiagnosticsTransport = 'http' | 'websocket';

/** Where in the operation's lifecycle it failed (`kugel.failure_stage`). */
export type DiagnosticsFailureStage =
  | 'connecting'
  | 'handshake'
  | 'sending_request'
  | 'awaiting_first_audio'
  | 'receiving_audio'
  | 'finalizing';

/**
 * How the operation ended (`kugel.outcome`). Only failures are events:
 * successes and caller cancellations are counted into `sdk_stats`.
 */
export type DiagnosticsOutcome = 'failed';

/** Which wrapper the SDK is being driven through (`kugel.integration`). */
export type DiagnosticsIntegration = 'none' | 'livekit' | 'pipecat';

/** Whether the effective API URL is KugelAudio-hosted (`kugel.endpoint_kind`). */
export type DiagnosticsEndpointKind = 'hosted' | 'custom';

/** String-valued attributes. Anything not listed here is dropped. */
const STRING_ATTRIBUTES: ReadonlySet<string> = new Set([
  'kugel.event',
  'kugel.event_id',
  'kugel.operation_id',
  'kugel.operation',
  'kugel.sdk.name',
  'kugel.sdk.version',
  'kugel.runtime',
  'kugel.integration',
  'kugel.transport',
  'kugel.failure_stage',
  'kugel.error_type',
  'kugel.error_code',
  'kugel.server_request_id',
  'kugel.outcome',
  'kugel.endpoint_kind',
]);

/** Int-valued attributes; OTLP JSON encodes int64 as a decimal string. */
const INT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'kugel.http_status',
  'kugel.ws_close_code',
  'kugel.elapsed_ms',
  'kugel.audio_chunks',
  'kugel.audio_bytes',
  'kugel.retry_count',
  'kugel.success_count',
  'kugel.failure_count',
  'kugel.cancelled_count',
]);

/** Every allowlisted key, in table order. The golden batch covers all of them. */
export const ALLOWLISTED_ATTRIBUTES: readonly string[] = [
  ...STRING_ATTRIBUTES,
  ...INT_ATTRIBUTES,
];

/** The contract's value shape for every string attribute. */
const STRING_VALUE = /^[A-Za-z0-9_.:/+-]{1,64}$/;

/** Attribute bag accepted by the encoder. */
export type DiagnosticsAttributes = Record<string, string | number | undefined>;

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpKeyValue[];
}

/**
 * Encode an attribute bag, dropping every key outside the allowlist and every
 * string value outside the contract's character set.
 *
 * This is the single choke point that keeps input text, API keys, URLs and
 * exception messages out of the payload: a caller cannot smuggle a value
 * through by inventing a key, and a free-text value (spaces, `?`, `@`) never
 * matches the value pattern.
 */
export function encodeAttributes(attributes: DiagnosticsAttributes): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (STRING_ATTRIBUTES.has(key)) {
      const text = String(value);
      if (STRING_VALUE.test(text)) out.push({ key, value: { stringValue: text } });
      continue;
    }
    if (INT_ATTRIBUTES.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      out.push({ key, value: { intValue: String(Math.trunc(n)) } });
    }
    // Anything else is silently dropped: that is the allowlist.
  }
  return out;
}

/** Identity and clock values the reporter supplies for one record. */
export interface RecordIdentity {
  /** 32 lowercase hex. */
  eventId: string;
  /** Nanoseconds since the epoch, as a decimal string. */
  timeUnixNano: string;
  /** Used when the attributes carry no `kugel.operation_id` of their own. */
  fallbackOperationId: string;
  sdkVersion: string;
  /** `node/X.Y.Z`; omitted outside Node. */
  runtime?: string;
  integration: DiagnosticsIntegration;
  endpointKind: DiagnosticsEndpointKind;
}

/** Build one log record: the event's attributes plus the required identity keys. */
export function buildLogRecord(
  event: DiagnosticsEventName,
  attributes: DiagnosticsAttributes,
  identity: RecordIdentity,
): OtlpLogRecord {
  const severity = event === 'sdk_stats' ? SEVERITY_INFO : SEVERITY_ERROR;
  return {
    timeUnixNano: identity.timeUnixNano,
    severityNumber: severity.number,
    severityText: severity.text,
    body: { stringValue: event },
    attributes: encodeAttributes({
      ...attributes,
      'kugel.event': event,
      'kugel.event_id': identity.eventId,
      'kugel.operation_id':
        (attributes['kugel.operation_id'] as string | undefined) ||
        identity.fallbackOperationId,
      'kugel.sdk.name': SDK_NAME,
      'kugel.sdk.version': identity.sdkVersion,
      'kugel.runtime': identity.runtime,
      'kugel.integration': identity.integration,
      'kugel.endpoint_kind': identity.endpointKind,
    }),
  };
}

/** Wrap encoded log records in the contract's resource/scope envelope. */
export function encodeOtlpPayload(records: OtlpLogRecord[], sdkVersion: string): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: SERVICE_NAME } },
            { key: 'service.version', value: { stringValue: sdkVersion } },
            {
              key: 'telemetry.sdk.language',
              value: { stringValue: TELEMETRY_LANGUAGE },
            },
          ],
        },
        scopeLogs: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            logRecords: records,
          },
        ],
      },
    ],
  });
}
