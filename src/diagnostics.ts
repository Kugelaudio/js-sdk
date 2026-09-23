/**
 * Client-side error diagnostics.
 *
 * One event per *failed operation*, never one per internal throw. Callers
 * mint an {@link Operation} per unit of work (an HTTP call, a one-shot
 * stream, a session connection, one streaming turn); the operation
 * accumulates transport, stage, chunk and retry state as it runs and reports
 * exactly one OTLP log record if it ends badly.
 *
 * Normative source: `services/ingress/docs/sdk-diagnostics-contract.md` (v3):
 * operation scope, event classification, enablement and delivery bounds are
 * defined there and are identical in the Python and Java SDKs. The wire
 * encoding lives in `diagnosticsWire.ts`.
 *
 * Delivery goes to our own authenticated API (`POST <api base>/v1/sdk-diagnostics`)
 * with the SDK's existing auth headers. Nothing here is allowed to reach the
 * caller: every failure inside the reporter is swallowed, delivery is off the
 * caller's path, every timer is `unref()`'d, and `close()` aborts whatever is
 * still on the wire after 1 s so a queued batch never holds the process open.
 *
 * Internal module: nothing here is exported from the package entry point.
 */

import {
  buildLogRecord,
  encodeOtlpPayload,
  type DiagnosticsAttributes,
  type DiagnosticsEndpointKind,
  type DiagnosticsEventName,
  type DiagnosticsFailureStage,
  type DiagnosticsIntegration,
  type DiagnosticsOperationName,
  type DiagnosticsOutcome,
  type DiagnosticsTransport,
  type OtlpLogRecord,
} from './diagnosticsWire';

export type {
  DiagnosticsAttributes,
  DiagnosticsEndpointKind,
  DiagnosticsEventName,
  DiagnosticsFailureStage,
  DiagnosticsIntegration,
  DiagnosticsOperationName,
  DiagnosticsTransport,
} from './diagnosticsWire';

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/** Path appended to the effective API base URL. There is no override. */
export const TELEMETRY_PATH = '/v1/sdk-diagnostics';

const HOSTED_HOST_SUFFIX = '.kugelaudio.com';

/** Bounded queue capacity; when full the OLDEST event is dropped. */
const QUEUE_CAPACITY = 64;
/** Flush as soon as this many events are queued; also the per-POST cap. */
const BATCH_SIZE = 8;
/** …or this long after the first event was queued. */
const FLUSH_INTERVAL_MS = 5_000;
/** Per-request timeout for the default sender. */
const SEND_TIMEOUT_MS = 3_000;
/** Total attempts for one batch: the initial send plus at most one retry. */
const MAX_SEND_ATTEMPTS = 2;
/** Total wait `close()` allows the final flush before aborting it. */
const SHUTDOWN_DEADLINE_MS = 1_000;
/**
 * Consecutive `404` batches that permanently disable the reporter. An ingress
 * older than the `/v1/sdk-diagnostics` route must not be pestered for the rest
 * of the process.
 */
const MAX_CONSECUTIVE_NOT_FOUND = 3;
const HTTP_NOT_FOUND = 404;

// ---------------------------------------------------------------------------
// Exit flush (contract "Delivery": Node `beforeExit`, guarded to run once)
// ---------------------------------------------------------------------------

/** Reporters holding queued records that no `close()` has claimed yet. */
const exitFlushCandidates = new Set<Diagnostics>();
let exitHookInstalled = false;

interface NodeProcessEvents {
  on(event: 'beforeExit', listener: () => void): unknown;
  off(event: 'beforeExit', listener: () => void): unknown;
  versions?: { node?: string };
}

/** `process` when it is Node's (browsers, edge and Deno have none of this). */
function nodeProcess(): NodeProcessEvents | undefined {
  try {
    const proc = (globalThis as { process?: Partial<NodeProcessEvents> }).process;
    if (!proc?.versions?.node || typeof proc.on !== 'function' || typeof proc.off !== 'function') {
      return undefined;
    }
    return proc as NodeProcessEvents;
  } catch {
    return undefined;
  }
}

/**
 * `beforeExit` fires when the event loop has drained. Each candidate flushes
 * at most once; the flush's own network work refills the loop, and when it
 * drains again `beforeExit` fires again, finds nothing left to do, and the
 * process exits.
 */
function onBeforeExit(): void {
  for (const reporter of [...exitFlushCandidates]) reporter.exitFlush();
}

function watchForExit(reporter: Diagnostics): void {
  exitFlushCandidates.add(reporter);
  if (exitHookInstalled) return;
  const proc = nodeProcess();
  if (!proc) return;
  proc.on('beforeExit', onBeforeExit);
  exitHookInstalled = true;
}

function unwatchForExit(reporter: Diagnostics): void {
  exitFlushCandidates.delete(reporter);
  if (!exitHookInstalled || exitFlushCandidates.size > 0) return;
  nodeProcess()?.off('beforeExit', onBeforeExit);
  exitHookInstalled = false;
}

/**
 * Injectable transport. Unit tests pass a fake that records
 * `(url, headers, payload)` so no test performs real network I/O.
 *
 * Returns the HTTP status of the response it obtained, or nothing when no
 * response was obtained at all (network error, timeout, no `fetch`). The
 * reporter reads the status only to notice an ingress without the diagnostics
 * route. `signal` aborts when `close()` gives up on the delivery.
 *
 * Implementations should not throw; the reporter swallows it regardless.
 */
export type DiagnosticsSender = (
  url: string,
  headers: Record<string, string>,
  payload: string,
  signal?: AbortSignal,
) => number | void | Promise<number | void>;

/** Minimal `process.env` shape, so tests can inject an environment. */
export type DiagnosticsEnv = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Environment / enablement
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * Read `process.env` without assuming it exists. The package ships a
 * browser-capable build, so `process` may be entirely absent.
 */
function processEnv(): DiagnosticsEnv {
  try {
    if (typeof process === 'undefined' || !process || !process.env) return {};
    return process.env as DiagnosticsEnv;
  } catch {
    return {};
  }
}

/** `hosted` when the effective API URL host ends in `.kugelaudio.com`. */
export function endpointKindFor(apiUrl: string): DiagnosticsEndpointKind {
  try {
    const host = new URL(apiUrl).hostname.toLowerCase();
    return host.endsWith(HOSTED_HOST_SUFFIX) ? 'hosted' : 'custom';
  } catch {
    return 'custom';
  }
}

/**
 * Resolve whether diagnostics are enabled. First match wins:
 *
 * 1. `KUGELAUDIO_TELEMETRY` in `0/false/off/no` (disabled) or `1/true/on/yes`
 *    (enabled): the environment overrides the constructor option.
 * 2. The explicit `telemetry` option.
 * 3. Enabled only for a KugelAudio-hosted endpoint.
 */
export function resolveTelemetryEnabled(
  apiUrl: string,
  telemetry?: boolean,
  env: DiagnosticsEnv = processEnv(),
): boolean {
  const raw = (env.KUGELAUDIO_TELEMETRY ?? '').trim().toLowerCase();
  if (FALSY.has(raw)) return false;
  if (TRUTHY.has(raw)) return true;
  if (telemetry !== undefined) return telemetry;
  return endpointKindFor(apiUrl) === 'hosted';
}

/** `node/<major.minor.patch>`, or undefined outside Node. */
export function runtimeString(): string | undefined {
  try {
    const version = typeof process !== 'undefined' ? process.versions?.node : undefined;
    if (!version) return undefined;
    const m = /^(\d+\.\d+\.\d+)/.exec(version);
    return m ? `node/${m[1]}` : undefined;
  } catch {
    return undefined;
  }
}

/** 32 lowercase hex characters. */
function randomHex32(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID().replace(/-/g, '').toLowerCase();
  }
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  while (out.length < 32) {
    out += Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, 32);
}

/** Detach a timer from the event loop where the runtime supports it. */
function unrefTimer(timer: unknown): void {
  const t = timer as { unref?: () => void } | null;
  if (t && typeof t.unref === 'function') t.unref();
}

/**
 * Whether an error represents caller cancellation rather than a failure.
 * `AbortError` is what `AbortController` produces in both Node and browsers.
 */
export function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'CanceledError';
}

/** The error CLASS name, never a message, which may contain user text. */
function errorTypeName(error: unknown): string {
  if (!error || typeof error !== 'object') return typeof error;
  const named = error as { name?: unknown; constructor?: { name?: string } };
  if (typeof named.name === 'string' && named.name) return named.name;
  return named.constructor?.name ?? 'Error';
}

// ---------------------------------------------------------------------------
// Default sender
// ---------------------------------------------------------------------------

/** Transport errors and 5xx get the one retry; a 413 or any 4xx never does. */
function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status >= 500;
}

/**
 * `fetch` delivery: 3 s timeout per attempt, at most one retry, then the
 * batch is dropped. Never rejects. `signal` (from `close()`) aborts the
 * attempt in flight and suppresses the retry.
 *
 * Resolves with the status of the last response obtained, or `undefined`
 * when no response was obtained at all.
 */
export async function fetchSender(
  url: string,
  headers: Record<string, string>,
  payload: string,
  signal?: AbortSignal,
): Promise<number | void> {
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    if (signal?.aborted || typeof fetch !== 'function') return lastStatus;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, SEND_TIMEOUT_MS);
    unrefTimer(timer);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });
      lastStatus = response.status;
      // Release the connection: the body (202, empty) is never read.
      void response.body?.cancel().catch(() => {});
    } catch {
      // KEEP-JUSTIFIED: telemetry must never surface to the caller; a failed
      // attempt leaves lastStatus as it was and is retried at most once.
      lastStatus = undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (!isRetryableStatus(lastStatus)) return lastStatus;
  }
  return lastStatus;
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

/**
 * A handle for one unit of work (contract "Operation scope").
 *
 * Minted before connecting (or, for a streaming turn, when its first text is
 * sent), mutated as the work progresses, and settled exactly once.
 * `fail()` and `succeed()` are idempotent, so the same handle can be
 * threaded through retry paths and error callbacks without risking a
 * duplicate event.
 */
export class Operation {
  /** 32 lowercase hex, stable for the whole operation including retries. */
  readonly operationId: string;
  /** `undefined` for work the contract names no operation for. */
  readonly operation: DiagnosticsOperationName | undefined;
  readonly transport: DiagnosticsTransport;

  private readonly diagnostics: Diagnostics;
  private readonly startedAt: number;
  private stage: DiagnosticsFailureStage;
  private chunks = 0;
  private bytes = 0;
  private retries = 0;
  private cancelled = false;
  private responded = false;
  private settledFlag = false;
  private wsCloseCode?: number;
  private serverRequestId?: string;
  private serverErrorCode?: string;

  constructor(
    diagnostics: Diagnostics,
    operation: DiagnosticsOperationName | undefined,
    transport: DiagnosticsTransport,
    stage: DiagnosticsFailureStage = 'connecting',
  ) {
    this.diagnostics = diagnostics;
    this.operation = operation;
    this.transport = transport;
    this.startedAt = Date.now();
    this.stage = stage;
    // Only pay for an id when something could actually be reported.
    this.operationId = diagnostics.active ? randomHex32() : '';
  }

  /** Milliseconds since the operation was minted. */
  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Number of audio chunks delivered to the caller so far. */
  get audioChunks(): number {
    return this.chunks;
  }

  /** Current failure stage; reported verbatim if the operation fails now. */
  get failureStage(): DiagnosticsFailureStage {
    return this.stage;
  }

  /** Retries performed inside this operation (e.g. a rolling-deploy replay). */
  get retryCount(): number {
    return this.retries;
  }

  /** Whether `succeed()` or `fail()` already ran. */
  get settled(): boolean {
    return this.settledFlag;
  }

  markStage(stage: DiagnosticsFailureStage): void {
    this.stage = stage;
  }

  /**
   * Count one delivered audio chunk. The first one moves the operation from
   * `awaiting_first_audio` to `receiving_audio`; no other stage advances.
   */
  recordChunk(byteLength = 0): void {
    this.chunks += 1;
    this.bytes += byteLength;
    if (this.stage === 'awaiting_first_audio') this.stage = 'receiving_audio';
  }

  markRetry(): void {
    this.retries += 1;
  }

  /**
   * The caller asked for this to stop. Not a failure, and not an event: the
   * operation settles into the cancellation counter only.
   */
  markCancelled(): void {
    this.cancelled = true;
  }

  /** Settle as a caller cancellation. */
  cancel(): void {
    this.cancelled = true;
    this.fail(undefined);
  }

  /**
   * The server answered with an error (a WS error frame): the failure
   * classifies as `request_failed` rather than a drop, and the frame's
   * `error_code` / `request_id` win over whatever wrapper error the caller
   * finally sees (the LiveKit plugin rethrows frames as `APIStatusError`).
   */
  markServerError(error: unknown): void {
    this.responded = true;
    const typed = error as { errorCode?: unknown; requestId?: unknown } | null;
    if (typeof typed?.errorCode === 'string') this.serverErrorCode = typed.errorCode;
    if (typeof typed?.requestId === 'string') this.serverRequestId = typed.requestId;
  }

  markWsCloseCode(code: number | undefined): void {
    if (typeof code === 'number') this.wsCloseCode = code;
  }

  markServerRequestId(requestId: string | undefined): void {
    if (requestId) this.serverRequestId = requestId;
  }

  /** Settle successfully. Emits no event; counts towards `sdk_stats`. */
  succeed(): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.diagnostics.recordSuccess();
  }

  /**
   * Settle as failed (or cancelled). A real failure emits exactly one event,
   * ever: later calls on the same handle are ignored.
   *
   * A caller-initiated cancellation only increments the cancellation counter
   * (reported via `sdk_stats`) and emits no record; otherwise every barge-in
   * in a voice agent would cost one ERROR-severity record.
   */
  fail(error: unknown): void {
    if (this.settledFlag) return;
    this.settledFlag = true;

    if (this.cancelled || isCancellation(error)) {
      this.diagnostics.recordCancellation();
      return;
    }
    this.diagnostics.recordFailure();
    if (!this.diagnostics.active) return;

    const typed = error as {
      statusCode?: unknown;
      errorCode?: unknown;
      requestId?: unknown;
    } | null;

    this.diagnostics.report(this.eventName(), {
      'kugel.operation_id': this.operationId,
      'kugel.operation': this.operation,
      'kugel.transport': this.transport,
      'kugel.failure_stage': this.stage,
      'kugel.error_type': errorTypeName(error),
      'kugel.error_code':
        this.serverErrorCode ??
        (typeof typed?.errorCode === 'string' ? typed.errorCode : undefined),
      'kugel.http_status':
        typeof typed?.statusCode === 'number' ? typed.statusCode : undefined,
      'kugel.ws_close_code': this.wsCloseCode,
      'kugel.server_request_id':
        this.serverRequestId ??
        (typeof typed?.requestId === 'string' ? typed.requestId : undefined),
      'kugel.elapsed_ms': this.elapsedMs,
      'kugel.audio_chunks': this.chunks,
      'kugel.audio_bytes': this.bytes,
      'kugel.retry_count': this.retries,
      'kugel.outcome': 'failed' satisfies DiagnosticsOutcome,
    });
  }

  /**
   * Contract "Event classification". `retry_exhausted` beats the rest: a
   * failure that already burned a retry is the more actionable signal.
   */
  private eventName(): DiagnosticsEventName {
    if (this.retries > 0) return 'retry_exhausted';
    if (this.stage === 'connecting' || this.stage === 'handshake') {
      return 'connection_failed';
    }
    if (this.transport === 'http' || this.responded) return 'request_failed';
    return 'stream_interrupted';
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DiagnosticsOptions {
  /**
   * Effective API base URL. Decides `kugel.endpoint_kind`, the enablement
   * default, and the delivery target (`<apiUrl>/v1/sdk-diagnostics`).
   */
  apiUrl: string;
  /** Installed SDK version, reported as `kugel.sdk.version`. */
  sdkVersion: string;
  /**
   * The SDK's existing auth headers, passed through verbatim onto the
   * diagnostics POST. Diagnostics never builds credentials of its own.
   */
  authHeaders?: Record<string, string>;
  /** Explicit opt-in/opt-out; the environment still overrides it. */
  telemetry?: boolean;
  /** Wrapper driving the SDK, fixed per client. */
  integration?: DiagnosticsIntegration;
  /** Injectable transport for tests. Defaults to {@link fetchSender}. */
  sender?: DiagnosticsSender;
  /** Injectable environment for tests. Defaults to `process.env`. */
  env?: DiagnosticsEnv;
}

/**
 * Bounded, batching, non-blocking OTLP reporter.
 *
 * Inert (no queueing, no network) when disabled, after `close()`, or once the
 * target has answered `404` three times in a row.
 */
export class Diagnostics {
  readonly enabled: boolean;
  /** Full delivery URL: always `<apiUrl>/v1/sdk-diagnostics`. */
  readonly endpoint: string;
  readonly endpointKind: DiagnosticsEndpointKind;
  readonly sdkVersion: string;
  readonly integration: DiagnosticsIntegration;

  private sender: DiagnosticsSender;
  private readonly headers: Record<string, string>;
  private readonly runtime: string | undefined;
  private readonly sessionId: string;
  private queue: OtlpLogRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The drain loop currently delivering batches, one POST at a time. Events
   * produced meanwhile pile up in the bounded queue, which is what makes the
   * capacity bound do any work.
   */
  private draining: Promise<void> | null = null;
  /** Aborts the POST on the wire when `close()` runs out of time. */
  private inFlight: AbortController | null = null;
  private successes = 0;
  private failures = 0;
  private cancellations = 0;
  private dropped = 0;
  private closed = false;
  /** Set when `close()` gave up: nothing more goes on the wire. */
  private abandoned = false;
  /** Consecutive `404` batches; three of them retire the reporter. */
  private notFoundStreak = 0;
  /** Set once the target has proved it has no diagnostics route. */
  private routeMissing = false;

  constructor(options: DiagnosticsOptions) {
    const env = options.env ?? processEnv();
    this.sdkVersion = options.sdkVersion;
    this.endpointKind = endpointKindFor(options.apiUrl);
    this.enabled = resolveTelemetryEnabled(options.apiUrl, options.telemetry, env);
    this.endpoint = `${options.apiUrl.replace(/\/+$/, '')}${TELEMETRY_PATH}`;
    // Content-Type goes on LAST so no caller-supplied header can override it.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.authHeaders ?? {})) {
      if (key.toLowerCase() !== 'content-type') headers[key] = value;
    }
    headers['Content-Type'] = 'application/json';
    this.headers = headers;
    this.integration = options.integration ?? 'none';
    this.sender = options.sender ?? fetchSender;
    this.runtime = runtimeString();
    this.sessionId = randomHex32();
  }

  /**
   * Whether anything will actually be reported: enabled, not closed, and the
   * target has not already told us three times that the route does not exist.
   */
  get active(): boolean {
    return this.enabled && !this.closed && !this.routeMissing;
  }

  /** Counters behind `sdk_stats`; exposed for tests and debugging. */
  get counters(): {
    successes: number;
    failures: number;
    cancellations: number;
    dropped: number;
    queued: number;
  } {
    return {
      successes: this.successes,
      failures: this.failures,
      cancellations: this.cancellations,
      dropped: this.dropped,
      queued: this.queue.length,
    };
  }

  /**
   * Replace the transport. The reporter is constructed deep inside the
   * client, so this is how a test swaps in a recording sender and keeps the
   * suite off the network.
   *
   * @internal
   */
  setSender(sender: DiagnosticsSender): void {
    this.sender = sender;
  }

  /** Mint an operation handle. Cheap and safe to call when inactive. */
  startOperation(
    operation: DiagnosticsOperationName | undefined,
    transport: DiagnosticsTransport,
    stage?: DiagnosticsFailureStage,
  ): Operation {
    return new Operation(this, operation, transport, stage);
  }

  /**
   * Run `fn` under a fresh operation handle: success and failure are settled
   * for the caller, and the original error is always rethrown unchanged.
   */
  async run<T>(
    operation: DiagnosticsOperationName | undefined,
    transport: DiagnosticsTransport,
    fn: (op: Operation) => Promise<T>,
  ): Promise<T> {
    const op = this.startOperation(operation, transport);
    try {
      const result = await fn(op);
      op.succeed();
      return result;
    } catch (error) {
      op.fail(error);
      throw error;
    }
  }

  recordSuccess(): void {
    this.successes += 1;
  }

  recordFailure(): void {
    this.failures += 1;
  }

  /**
   * Cancellation is deliberately neither a success nor a failure, and emits
   * no individual event. This counter is its only report, via
   * `kugel.cancelled_count` on `sdk_stats`.
   */
  recordCancellation(): void {
    this.cancellations += 1;
  }

  /**
   * Queue one event. Adds the required identity attributes, enforces the
   * queue bound (oldest dropped) and schedules delivery off the caller's
   * path. Never throws.
   */
  report(event: DiagnosticsEventName, attributes: DiagnosticsAttributes = {}): void {
    if (!this.active) return;
    try {
      watchForExit(this);
      this.queue.push(
        buildLogRecord(event, attributes, {
          eventId: randomHex32(),
          timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
          fallbackOperationId: this.sessionId,
          sdkVersion: this.sdkVersion,
          runtime: this.runtime,
          integration: this.integration,
          endpointKind: this.endpointKind,
        }),
      );
      while (this.queue.length > QUEUE_CAPACITY) {
        this.queue.shift();
        this.dropped += 1;
      }

      if (this.queue.length >= BATCH_SIZE) {
        // A running drain loop picks this batch up after the POST on the
        // wire lands; starting a second one would defeat the queue bound.
        if (this.draining === null) void this.flush();
      } else if (this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, FLUSH_INTERVAL_MS);
        unrefTimer(this.timer);
      }
    } catch {
      // KEEP-JUSTIFIED: telemetry must never surface to the caller.
    }
  }

  /**
   * Deliver everything queued, at most {@link BATCH_SIZE} records per POST.
   * Joins the running drain loop if there is one. Never rejects.
   */
  flush(): Promise<void> {
    this.clearTimer();
    if (this.draining) return this.draining;
    if (this.routeMissing || this.abandoned) this.queue = [];
    if (this.queue.length === 0) return Promise.resolve();
    this.draining = this.drain();
    return this.draining;
  }

  /**
   * POST batches until the queue is empty. Starts with a non-empty queue, so
   * it always awaits at least once before `draining` is cleared, and clears
   * it synchronously with the final empty-queue check so no record can slip
   * in between the check and the reset.
   */
  private async drain(): Promise<void> {
    for (;;) {
      if (this.routeMissing || this.abandoned) this.queue = [];
      if (this.queue.length === 0) {
        this.draining = null;
        // Nothing left for an exit flush; the next record re-registers.
        unwatchForExit(this);
        return;
      }
      await this.deliver(this.queue.splice(0, BATCH_SIZE));
    }
  }

  /**
   * One batch on the wire. Never rejects.
   *
   * Every non-2xx is a silent drop; the status is read for exactly one
   * purpose, noticing an API with no diagnostics route. A transport error
   * yields no status and therefore neither extends nor breaks the streak.
   */
  private async deliver(batch: OtlpLogRecord[]): Promise<void> {
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const status = await this.sender(
        this.endpoint,
        { ...this.headers },
        encodeOtlpPayload(batch, this.sdkVersion),
        controller.signal,
      );
      if (typeof status !== 'number') return;
      if (status === HTTP_NOT_FOUND) {
        this.notFoundStreak += 1;
        if (this.notFoundStreak >= MAX_CONSECUTIVE_NOT_FOUND) this.routeMissing = true;
        return;
      }
      this.notFoundStreak = 0;
    } catch {
      // KEEP-JUSTIFIED: telemetry must never surface; the batch is dropped.
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  /**
   * Enqueue `sdk_stats`, hand the flush to the background drain and wait at
   * most 1 s in total. Past the deadline the POST on the wire is aborted and
   * the rest of the queue dropped, so nothing keeps the process alive.
   * Idempotent; a synchronous caller may drop the promise.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    if (
      this.active &&
      (this.successes > 0 || this.failures > 0 || this.cancellations > 0)
    ) {
      this.report('sdk_stats', {
        'kugel.operation_id': this.sessionId,
        'kugel.success_count': this.successes,
        'kugel.failure_count': this.failures,
        // The only place cancellations are reported: they emit no individual
        // event, so without this counter the signal would be lost entirely.
        'kugel.cancelled_count': this.cancellations,
      });
    }
    this.closed = true;
    // An explicit close makes the exit flush a no-op.
    unwatchForExit(this);
    this.clearTimer();
    await this.flushWithin(SHUTDOWN_DEADLINE_MS);
  }

  /**
   * Exit flush for a client that was never closed: runs once, only when
   * records are queued, and waits at most 1 s. Called from `beforeExit`.
   *
   * @internal
   */
  exitFlush(): void {
    unwatchForExit(this);
    if (this.closed || !this.enabled || this.queue.length === 0) return;
    void this.flushWithin(SHUTDOWN_DEADLINE_MS);
  }

  /**
   * Flush, but give up after `ms`: abort the POST on the wire and drop the
   * rest, so nothing keeps the process alive past the deadline.
   */
  private async flushWithin(ms: number): Promise<void> {
    this.clearTimer();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      deadline = setTimeout(() => resolve(true), ms);
      unrefTimer(deadline);
    });
    const timedOut = await Promise.race([this.flush().then(() => false), expired]);
    clearTimeout(deadline);
    if (timedOut) {
      this.abandoned = true;
      this.queue = [];
      this.inFlight?.abort();
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Map an HTTP path to its `kugel.operation`, or `undefined` for a path the
 * contract has no operation for (the attribute is then omitted rather than
 * mislabelled).
 */
export function operationForPath(path: string): DiagnosticsOperationName | undefined {
  if (path.startsWith('/v1/audio/transcriptions')) return 'transcribe';
  if (path.startsWith('/v1/models')) return 'models';
  if (path.startsWith('/v1/dictionaries')) return 'dictionaries';
  if (path.startsWith('/v1/voices')) return 'voices';
  return undefined;
}
