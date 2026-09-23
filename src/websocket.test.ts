/**
 * Resolver order of `websocket.ts` as the ESM build sees it (vitest runs the
 * module as ESM, so `import.meta.url` is set): a sync `require` through
 * `process.getBuiltinModule` when it exists, else an async `import('ws')`,
 * else the native WebSocket. Each test loads a fresh module (fresh cache).
 */
import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wsPackage = createRequire(import.meta.url)('ws') as typeof WebSocket;

type Resolver = typeof import('./websocket');
const freshResolver = async (): Promise<Resolver> => {
  vi.resetModules();
  return import('./websocket');
};

describe('WebSocket resolver', () => {
  const realGetBuiltin = process.getBuiltinModule;

  beforeEach(() => {
    expect(typeof realGetBuiltin).toBe('function');
  });

  afterEach(() => {
    process.getBuiltinModule = realGetBuiltin;
    vi.doUnmock('ws');
  });

  it('resolves `ws` synchronously when process.getBuiltinModule exists', async () => {
    const { getWebSocket } = await freshResolver();
    expect(getWebSocket()).toBe(wsPackage);
  });

  it('without process.getBuiltinModule: no sync answer, then `ws` via import(), cached', async () => {
    // @ts-expect-error simulating Node 18.x / 20.0-20.15 / 22.0-22.2
    delete process.getBuiltinModule;
    const { getWebSocket, loadWebSocket } = await freshResolver();

    expect(getWebSocket()).toBeUndefined();
    const loading = loadWebSocket();
    expect(loadWebSocket()).toBe(loading); // one import in flight
    const WS = await loading;

    expect(WS).toBe(wsPackage);
    expect(WS).not.toBe(globalThis.WebSocket);
    expect(getWebSocket()).toBe(WS);
  });

  it('without process.getBuiltinModule and without `ws`: the native WebSocket', async () => {
    // @ts-expect-error simulating Node 22.0-22.2
    delete process.getBuiltinModule;
    vi.doMock('ws', () => {
      throw new Error("Cannot find package 'ws'");
    });
    const { getWebSocket, loadWebSocket } = await freshResolver();

    expect(getWebSocket()).toBeUndefined();
    await expect(loadWebSocket()).resolves.toBe(globalThis.WebSocket);
    expect(getWebSocket()).toBe(globalThis.WebSocket);
  });
});
