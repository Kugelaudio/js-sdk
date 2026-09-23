/**
 * Custom errors for KugelAudio SDK.
 *
 * All SDK errors inherit from {@link KugelAudioError}. Specific subclasses
 * map to the server's `error_code` field (see the server-side `ErrorCode`
 * enum at `models/tts/src/serving/deployments/errors.py`) so callers can
 * `instanceof AuthenticationError` without matching on message text.
 */

// Keep in lockstep with the server `ErrorCode` enum.
export const ErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  EMPTY_AUDIO: 'EMPTY_AUDIO',
  VALIDATION: 'VALIDATION_ERROR',
  INTERNAL: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  MISSING_VOICE_ID: 'MISSING_VOICE_ID',
  TOO_MANY_CONTEXTS: 'TOO_MANY_CONTEXTS',
} as const;
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// Server-defined WebSocket close codes.
export const WsCloseCodes = {
  UNAUTHORIZED: 4001,
  INSUFFICIENT_CREDITS: 4003,
  RATE_LIMITED: 4029,
  MODEL_UNAVAILABLE: 4500,
  // RFC 6455 codes the server uses during a rolling deploy.
  SERVICE_RESTART: 1012,
  TRY_AGAIN_LATER: 1013,
} as const;

const WS_ERROR_CLOSE_CODES: ReadonlySet<number> = new Set<number>(
  Object.values(WsCloseCodes),
);

/**
 * Whether a WebSocket close code is a server-initiated error that must be
 * surfaced to the caller (as opposed to a normal 1000/1001 close, which
 * simply ends the stream).
 */
export function isWsErrorCloseCode(code: number | undefined): boolean {
  return code !== undefined && WS_ERROR_CLOSE_CODES.has(code);
}

const API_KEYS_URL = 'https://app.kugelaudio.com/settings/api-keys';
const BILLING_URL = 'https://app.kugelaudio.com/billing';

export interface KugelAudioErrorOptions {
  statusCode?: number;
  errorCode?: string;
  requestId?: string;
  retryAfter?: number;
  cause?: unknown;
}

/**
 * Base error class for KugelAudio SDK.
 */
export class KugelAudioError extends Error {
  public readonly statusCode?: number;
  public readonly errorCode?: string;
  public readonly requestId?: string;
  public readonly retryAfter?: number;

  constructor(message: string, options: KugelAudioErrorOptions = {}) {
    super(options.requestId ? `${message} (request_id: ${options.requestId})` : message);
    this.name = 'KugelAudioError';
    this.statusCode = options.statusCode;
    this.errorCode = options.errorCode;
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter;
    Object.setPrototypeOf(this, KugelAudioError.prototype);
  }
}

/**
 * API key was missing, malformed, or rejected by the server.
 */
export class AuthenticationError extends KugelAudioError {
  constructor(message?: string, options: KugelAudioErrorOptions = {}) {
    super(
      message ?? `KugelAudio rejected the API key. Check it is current at ${API_KEYS_URL}.`,
      { statusCode: 401, errorCode: ErrorCodes.UNAUTHORIZED, ...options },
    );
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Request was rejected by the per-org rate limiter.
 */
export class RateLimitError extends KugelAudioError {
  constructor(message?: string, options: KugelAudioErrorOptions = {}) {
    const msg =
      message ??
      (options.retryAfter
        ? `KugelAudio rate limit hit; retry after ${options.retryAfter}s.`
        : 'KugelAudio rate limit hit; retry shortly.');
    super(msg, { statusCode: 429, errorCode: ErrorCodes.RATE_LIMITED, ...options });
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * Account is out of TTS credits.
 */
export class InsufficientCreditsError extends KugelAudioError {
  constructor(message?: string, options: KugelAudioErrorOptions = {}) {
    super(
      message ?? `Your KugelAudio account is out of credits. Top up at ${BILLING_URL}.`,
      { statusCode: 402, errorCode: ErrorCodes.INSUFFICIENT_CREDITS, ...options },
    );
    this.name = 'InsufficientCreditsError';
    Object.setPrototypeOf(this, InsufficientCreditsError.prototype);
  }
}

/**
 * Request was rejected as invalid (bad params, missing fields, etc.).
 */
export class ValidationError extends KugelAudioError {
  constructor(message: string, options: KugelAudioErrorOptions = {}) {
    super(message, { statusCode: 400, errorCode: ErrorCodes.VALIDATION, ...options });
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * The SDK could not reach KugelAudio (network error, server down,
 * or model deployment temporarily unavailable).
 */
export class ConnectionError extends KugelAudioError {
  constructor(message: string, options: KugelAudioErrorOptions = {}) {
    super(message, { statusCode: 503, ...options });
    this.name = 'ConnectionError';
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/**
 * The replica serving this WebSocket is restarting (rolling deploy).
 *
 * The server closes idle sockets with `1012` at once and busy sockets once
 * the current turn is complete, so every audio chunk received before this
 * error is complete up to the last chunk. Reconnect (the load balancer
 * routes to another replica) and resend the turn that was in flight, if
 * any. `1013` is the same condition seen at the handshake: the replica
 * accepted only long enough to report that it is draining. `retryAfter`
 * defaults to 1 second.
 */
export class ServerRestartingError extends ConnectionError {
  constructor(message?: string, options: KugelAudioErrorOptions = {}) {
    super(
      message ??
        'KugelAudio replica is restarting (rolling deploy). Reconnect and ' +
          'resend the current turn; audio already received is complete up ' +
          'to the last chunk.',
      { retryAfter: 1, ...options },
    );
    this.name = 'ServerRestartingError';
    Object.setPrototypeOf(this, ServerRestartingError.prototype);
  }
}

/**
 * A referenced resource doesn't exist or isn't visible to the caller.
 *
 * Surfaced when the server returns HTTP 404 with `error_code = NOT_FOUND` —
 * e.g. an unknown `voiceId`, a voice that belongs to another org, or a
 * deleted resource. Distinct from {@link ValidationError} (malformed
 * request) so callers can show "not found" UX without parsing messages.
 */
export class NotFoundError extends KugelAudioError {
  constructor(message?: string, options: KugelAudioErrorOptions = {}) {
    super(message ?? 'Not found.', {
      statusCode: 404,
      errorCode: ErrorCodes.NOT_FOUND,
      ...options,
    });
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

function build(
  status: number | undefined,
  errorCode: string | undefined,
  message: string,
  opts: { requestId?: string; retryAfter?: number; cause?: unknown } = {},
): KugelAudioError {
  // Only include keys whose value we actually know. Subclass constructors
  // spread `...options` over their canonical defaults (e.g. statusCode: 401),
  // so a key with `undefined` would clobber the default.
  const common: {
    statusCode?: number;
    errorCode?: string;
    requestId?: string;
    retryAfter?: number;
    cause?: unknown;
  } = { ...opts };
  if (status !== undefined) common.statusCode = status;
  if (errorCode !== undefined) common.errorCode = errorCode;

  if (errorCode === ErrorCodes.UNAUTHORIZED || status === 401) {
    return new AuthenticationError(message || undefined, common);
  }
  if (errorCode === ErrorCodes.INSUFFICIENT_CREDITS || status === 402) {
    return new InsufficientCreditsError(message || undefined, common);
  }
  if (
    errorCode === ErrorCodes.RATE_LIMITED ||
    errorCode === ErrorCodes.TOO_MANY_CONTEXTS ||
    status === 429
  ) {
    return new RateLimitError(message || undefined, common);
  }
  if (
    errorCode === ErrorCodes.VALIDATION ||
    errorCode === ErrorCodes.MISSING_VOICE_ID ||
    status === 400
  ) {
    return new ValidationError(message || 'Request validation failed.', common);
  }
  if (errorCode === ErrorCodes.MODEL_UNAVAILABLE || status === 503) {
    const detail = message || 'service temporarily unavailable';
    return new ConnectionError(
      `KugelAudio is temporarily unavailable: ${detail}. Retry shortly.`,
      common,
    );
  }
  if (errorCode === ErrorCodes.NOT_FOUND || status === 404) {
    return new NotFoundError(message || undefined, common);
  }
  return new KugelAudioError(message || `HTTP ${status}`, common);
}

interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null } | Record<string, string | undefined>;
  text?: () => Promise<string>;
}

function readHeader(
  headers: HttpResponseLike['headers'],
  name: string,
): string | undefined {
  if (headers && typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | undefined>;
  return rec[name] ?? rec[name.toLowerCase()] ?? undefined;
}

/**
 * Build the appropriate `KugelAudioError` from an HTTP response body that
 * was already parsed. `bodyText` is the raw text fallback.
 */
export function classifyHttpError(
  status: number,
  bodyText: string,
  headers: HttpResponseLike['headers'],
): KugelAudioError {
  let errorCode: string | undefined;
  let message = '';
  let retryAfter: number | undefined;

  if (bodyText) {
    try {
      const body = JSON.parse(bodyText);
      if (body && typeof body === 'object') {
        errorCode = typeof body.error_code === 'string' ? body.error_code : undefined;
        const msg = body.error ?? body.detail;
        if (Array.isArray(msg)) {
          message = msg.map((m) => String(m)).join('; ');
        } else if (typeof msg === 'string') {
          message = msg;
        }
        if (typeof body.retry_after === 'number') {
          retryAfter = body.retry_after;
        }
      }
    } catch {
      // Not JSON; fall back to raw body text below.
    }
  }

  if (retryAfter === undefined) {
    const header = readHeader(headers, 'Retry-After') ?? readHeader(headers, 'retry-after');
    if (header) {
      const n = Number(header);
      if (Number.isFinite(n)) retryAfter = n;
    }
  }

  const requestId = readHeader(headers, 'x-request-id') ?? readHeader(headers, 'X-Request-Id');

  if (!message) {
    message = (bodyText || '').trim();
  }

  return build(status, errorCode, message, { requestId, retryAfter });
}

/**
 * Build a `KugelAudioError` from a server-sent WebSocket error frame
 * (`{error, error_code, code, request_id}`).
 *
 * `request_id` is the connection-scoped id the ingress binds at WS accept
 * time and echoes on every error frame; it lands on the typed error's
 * {@link KugelAudioError.requestId} so a report can be correlated with the
 * server-side log line.
 */
export function classifyWsFrame(data: {
  error?: string;
  error_code?: string;
  code?: number;
  retry_after?: number;
  request_id?: string;
}): KugelAudioError {
  const errorCode = data.error_code;
  const message = data.error ?? 'Server reported an error.';
  const status = typeof data.code === 'number' ? data.code : undefined;
  const retryAfter = typeof data.retry_after === 'number' ? data.retry_after : undefined;
  const requestId = typeof data.request_id === 'string' ? data.request_id : undefined;
  return build(status, errorCode, message, { retryAfter, requestId });
}

/**
 * Build a `KugelAudioError` from a WebSocket close code + reason.
 *
 * `requestId`, when known, is the connection-scoped id from the handshake.
 */
export function classifyWsClose(
  code: number | undefined,
  reason?: string,
  requestId?: string,
): KugelAudioError {
  const reasonTxt = (reason ?? '').trim();
  // Only set the key when known: `undefined` would clobber a subclass default.
  const opts: KugelAudioErrorOptions = requestId ? { requestId } : {};

  if (code === WsCloseCodes.UNAUTHORIZED) {
    let msg = `KugelAudio rejected the API key. Check it is current at ${API_KEYS_URL}.`;
    if (reasonTxt) msg = `${msg} (${reasonTxt})`;
    return new AuthenticationError(msg, opts);
  }
  if (code === WsCloseCodes.INSUFFICIENT_CREDITS) {
    return new InsufficientCreditsError(undefined, opts);
  }
  if (code === WsCloseCodes.RATE_LIMITED) {
    return new RateLimitError(undefined, opts);
  }
  if (code === WsCloseCodes.MODEL_UNAVAILABLE) {
    const suffix = reasonTxt ? ` (${reasonTxt})` : '';
    return new ConnectionError(
      `KugelAudio model is temporarily unavailable. Retry shortly.${suffix}`,
      opts,
    );
  }
  if (
    code === WsCloseCodes.SERVICE_RESTART ||
    code === WsCloseCodes.TRY_AGAIN_LATER
  ) {
    return new ServerRestartingError(undefined, opts);
  }

  const detail = reasonTxt || 'no reason given';
  const codeStr = code !== undefined ? ` (code ${code})` : '';
  return new ConnectionError(
    `KugelAudio WebSocket closed by server: ${detail}${codeStr}.`,
    opts,
  );
}

/**
 * Extract the HTTP status from a `ws` package handshake-rejection error and
 * return a typed `KugelAudioError`. Returns `null` if the error doesn't look
 * like a handshake rejection (e.g. pure network failure).
 *
 * The `ws` library surfaces rejected upgrades via:
 *  - an Error whose `.message` is `"Unexpected server response: <status>"`
 *  - `error.code === 'EUNEXPECTEDRESPONSE'`, with `error.statusCode` on some versions
 *  - a kept rejection response `{statusCode, message, headers}`, whose
 *    `x-request-id` header becomes the error's `requestId`
 *
 * The TTS server rejects WS upgrades with a bare API key using HTTP 403
 * (not 401), so we treat 403 here as an auth failure — HTTP API callers
 * keep the generic 403 semantics via {@link classifyHttpError}.
 */
export function classifyWsHandshakeError(err: unknown): KugelAudioError | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    message?: unknown;
    statusCode?: unknown;
    code?: unknown;
    headers?: Record<string, string | string[] | undefined>;
  };

  let status: number | undefined;
  if (typeof e.statusCode === 'number') {
    status = e.statusCode;
  }
  if (status === undefined && typeof e.message === 'string') {
    const m = e.message.match(/Unexpected server response:\s*(\d{3})/i);
    if (m) status = Number(m[1]);
  }
  if (status === undefined) return null;

  // Ingress puts `x-request-id` on the rejection response itself; it is
  // present only when the caller kept the response (see handshake.ts).
  const rawId = e.headers?.['x-request-id'];
  const requestId = Array.isArray(rawId) ? rawId[0] : rawId;
  const opts = requestId ? { requestId } : {};

  if (status === 403) {
    return new AuthenticationError(undefined, opts);
  }
  return build(status, undefined, typeof e.message === 'string' ? e.message : '', opts);
}
