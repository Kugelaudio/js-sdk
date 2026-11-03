import { afterEach, describe, expect, it, vi } from 'vitest';
import { KugelAudioError } from './errors';
import * as runtime from './node-runtime';
import { masterKeyHeaders, socketCredential, withCredentialQuery } from './ws-auth';

const key = { apiKey: 'secret', isToken: false, isMasterKey: false };

describe('socketCredential', () => {
  afterEach(() => vi.restoreAllMocks());

  it('puts an API key in the query', () => {
    expect(socketCredential(key)).toEqual({ query: 'api_key=secret' });
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

describe('masterKeyHeaders (ASR and enhance sockets)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is undefined for an API key and for a token, which ride the query', () => {
    expect(masterKeyHeaders(key)).toBeUndefined();
    expect(masterKeyHeaders({ ...key, isToken: true, isMasterKey: true })).toBeUndefined();
  });

  it('is the bearer header for a master key, and refuses one outside Node.js', () => {
    expect(masterKeyHeaders({ ...key, isMasterKey: true })).toEqual({ Authorization: 'Bearer secret' });
    vi.spyOn(runtime, 'isNodeJs').mockReturnValue(false);
    expect(() => masterKeyHeaders({ ...key, isMasterKey: true })).toThrow(KugelAudioError);
  });
});

describe('withCredentialQuery', () => {
  it('appends the query pair', () => {
    expect(withCredentialQuery('wss://h/ws/tts', { query: 'api_key=k' })).toBe('wss://h/ws/tts?api_key=k');
  });
});
