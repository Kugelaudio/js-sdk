import { describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  ConnectionError,
  InsufficientCreditsError,
  KugelAudio,
  KugelAudioError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  classifyHttpError,
  classifyWsClose,
  classifyWsFrame,
  classifyWsHandshakeError,
} from '../src/index';

function headers(obj: Record<string, string>): Headers {
  return new Headers(obj);
}

describe('classifyHttpError', () => {
  it('unknown status falls back to base', () => {
    const err = classifyHttpError(418, JSON.stringify({ error: 'teapot' }), headers({}));
    expect(err.constructor.name).toBe('KugelAudioError');
    expect(err.statusCode).toBe(418);
  });

  it('404 without error_code still builds NotFoundError', () => {
    const err = classifyHttpError(
      404,
      JSON.stringify({ detail: 'nope' }),
      headers({}),
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toMatch(/nope/);
    expect(err.errorCode).toBe('NOT_FOUND');
  });

  it('error_code wins over status mismatch', () => {
    const err = classifyHttpError(
      500,
      JSON.stringify({ error: 'x', error_code: 'UNAUTHORIZED' }),
      headers({}),
    );
    expect(err).toBeInstanceOf(AuthenticationError);
  });

  it('fastapi detail field is read', () => {
    const err = classifyHttpError(
      400,
      JSON.stringify({ detail: 'field required' }),
      headers({}),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/field required/);
    // Canonical codes must be filled in even when the server body omitted
    // error_code — subclass defaults would otherwise be clobbered by
    // `...options` spreading undefined.
    expect(err.errorCode).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
  });

  it('retry_after header used when body missing it', () => {
    const err = classifyHttpError(
      429,
      JSON.stringify({ error: 'slow' }),
      headers({ 'Retry-After': '12' }),
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(12);
  });

  it('request_id header is captured', () => {
    const err = classifyHttpError(
      401,
      JSON.stringify({ error: 'bad', error_code: 'UNAUTHORIZED' }),
      headers({ 'x-request-id': 'req_abc' }),
    );
    expect(err.requestId).toBe('req_abc');
    expect(err.message).toMatch(/req_abc/);
  });

  it('unparseable body falls back to text', () => {
    const err = classifyHttpError(500, 'upstream exploded', headers({}));
    expect(err.constructor.name).toBe('KugelAudioError');
    expect(err.message).toMatch(/upstream exploded/);
  });
});

describe('classifyWsFrame', () => {
  it('frame without error_code is generic', () => {
    const err = classifyWsFrame({ error: 'something broke' });
    expect(err.constructor.name).toBe('KugelAudioError');
    expect(err.message).toMatch(/something broke/);
  });

  it('frame with retry_after', () => {
    const err = classifyWsFrame({
      error: 'slow',
      error_code: 'RATE_LIMITED',
      retry_after: 3,
    });
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(3);
  });

  it('ingress frame code classifies missing voice as validation', () => {
    const err = classifyWsFrame({
      error: 'voice_id is required',
      error_code: 'MISSING_VOICE_ID',
      code: 400,
    });
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe('MISSING_VOICE_ID');
  });

  it('ingress frame code classifies context cap as rate limit', () => {
    const err = classifyWsFrame({
      error: 'Too many concurrent contexts',
      error_code: 'TOO_MANY_CONTEXTS',
      code: 429,
    });
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.statusCode).toBe(429);
    expect(err.errorCode).toBe('TOO_MANY_CONTEXTS');
  });
});

describe('classifyWsClose', () => {
  it('unknown close code is ConnectionError', () => {
    const err = classifyWsClose(1011, 'server error');
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toMatch(/server error/);
  });

  it('no code and no reason', () => {
    const err = classifyWsClose(undefined);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toMatch(/no reason given/);
  });
});

describe('classifyWsHandshakeError', () => {
  it('403 maps to AuthenticationError (server uses 403 on WS upgrade)', () => {
    const err = classifyWsHandshakeError(
      new Error('Unexpected server response: 403'),
    );
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err?.statusCode).toBe(401);
  });

  it('429 maps to RateLimitError', () => {
    const err = classifyWsHandshakeError(
      new Error('Unexpected server response: 429'),
    );
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('reads error.statusCode when present', () => {
    const e = Object.assign(new Error('boom'), { statusCode: 402 });
    const err = classifyWsHandshakeError(e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
  });

  it('non-handshake error returns null', () => {
    expect(classifyWsHandshakeError(new Error('network down'))).toBeNull();
    expect(classifyWsHandshakeError(undefined)).toBeNull();
    expect(classifyWsHandshakeError({})).toBeNull();
  });
});

describe('KugelAudio constructor', () => {
  it('missing apiKey throws actionable ValidationError', () => {
    let caught: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      new KugelAudio({ apiKey: '' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const msg = (caught as Error).message;
    // The core client never reads the env var, so the message must not point at it.
    expect(msg).not.toMatch(/KUGELAUDIO_API_KEY/);
    expect(msg).toMatch(/apiKey/);
    expect(msg).toMatch(/https:\/\/app\.kugelaudio\.com\/settings\/api-keys/);
  });

  it('invalid region throws ValidationError', () => {
    expect(
      () =>
        new KugelAudio({
          apiKey: 'ka_test',
          // @ts-expect-error intentional bad value
          region: 'mars',
        }),
    ).toThrow(ValidationError);
  });
});
