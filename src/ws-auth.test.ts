import { afterEach, describe, expect, it, vi } from 'vitest';
import { KugelAudioError } from './errors';
import * as runtime from './node-runtime';
import { socketCredential, withCredentialQuery } from './ws-auth';

const key = { apiKey: 'secret', isToken: false, isMasterKey: false };

describe('socketCredential', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends an API key in the Authorization header on Node.js', () => {
    expect(socketCredential(key)).toEqual({ query: '', headers: { Authorization: 'Bearer secret' } });
  });

  it('puts a token in the query, even when isMasterKey is also set', () => {
    expect(socketCredential({ ...key, isToken: true, isMasterKey: true })).toEqual({ query: 'token=secret' });
  });

  it('sends a master key only as an Authorization header', () => {
    const credential = socketCredential({ ...key, isMasterKey: true });
    expect(credential).toEqual({ query: '', headers: { Authorization: 'Bearer secret' } });
    expect(withCredentialQuery('wss://h/ws/tts', credential)).toBe('wss://h/ws/tts');
  });

  it('refuses a master key outside Node.js, where a socket cannot carry headers', () => {
    vi.spyOn(runtime, 'isNodeJs').mockReturnValue(false);
    expect(() => socketCredential({ ...key, isMasterKey: true })).toThrow(KugelAudioError);
  });
});

describe('browser WebSocket credentials', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves JWT authentication without warning', () => {
    vi.spyOn(runtime, 'isNodeJs').mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(socketCredential({ ...key, apiKey: 'a.b.c', isToken: true })).toEqual({ query: 'token=a.b.c' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves legacy API key authentication and warns once without logging the key', () => {
    vi.spyOn(runtime, 'isNodeJs').mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(socketCredential(key)).toEqual({ query: 'api_key=secret' });
    expect(socketCredential({ ...key, apiKey: 'another-key' })).toEqual({ query: 'api_key=another-key' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('isToken: true');
    expect(warn.mock.calls[0][0]).not.toContain('secret');
  });
});

describe('withCredentialQuery', () => {
  it('appends the query pair', () => {
    expect(withCredentialQuery('wss://h/ws/tts', { query: 'token=a.b.c' })).toBe('wss://h/ws/tts?token=a.b.c');
  });
});
