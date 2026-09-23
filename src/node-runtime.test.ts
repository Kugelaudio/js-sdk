/**
 * `nodeReadable()` as the ESM build sees it (vitest runs modules as ESM):
 * synchronous through `process.getBuiltinModule`, a clear error without it.
 */
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeReadable } from './node-runtime';

describe('nodeReadable', () => {
  const realGetBuiltin = process.getBuiltinModule;

  afterEach(() => {
    process.getBuiltinModule = realGetBuiltin;
  });

  it('returns node:stream Readable synchronously when process.getBuiltinModule exists', () => {
    expect(nodeReadable()).toBe(Readable);
  });

  it('throws a clear error without process.getBuiltinModule (ESM on Node < 20.16 / 22.3)', () => {
    // @ts-expect-error simulating Node 18.x / 20.0-20.15 / 22.0-22.2
    delete process.getBuiltinModule;
    expect(() => nodeReadable()).toThrow(/toReadable\(\) needs .*Node >= 20\.16 \/ 22\.3.*CommonJS build/);
  });
});
