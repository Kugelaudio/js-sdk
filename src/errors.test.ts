/**
 * Close-code classification for rolling deploys (1012 / 1013).
 *
 * The ingress drains on a rolling deploy: idle sockets are closed with 1012,
 * busy sockets get their `session_closed` first and are then closed with
 * 1012, and an upgrade against a draining replica is refused with 1013.
 * None of those may read as a clean end of stream.
 */

import { describe, expect, it } from 'vitest';

import {
  ConnectionError,
  ServerRestartingError,
  classifyWsClose,
  isWsErrorCloseCode,
} from './errors';

describe('classifyWsClose restart codes', () => {
  it.each([1012, 1013])('%i maps to ServerRestartingError', (code) => {
    const err = classifyWsClose(code, 'server restarting');
    expect(err).toBeInstanceOf(ServerRestartingError);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.statusCode).toBe(503);
    expect(err.retryAfter).toBe(1);
  });

  it('1000 is not a restart', () => {
    expect(classifyWsClose(1000, '')).not.toBeInstanceOf(ServerRestartingError);
  });
});

describe('isWsErrorCloseCode', () => {
  it('flags every server error code including the restart pair', () => {
    for (const code of [4001, 4003, 4029, 4500, 1012, 1013]) {
      expect(isWsErrorCloseCode(code)).toBe(true);
    }
  });

  it('leaves normal closes alone', () => {
    expect(isWsErrorCloseCode(1000)).toBe(false);
    expect(isWsErrorCloseCode(1001)).toBe(false);
    expect(isWsErrorCloseCode(undefined)).toBe(false);
  });
});
