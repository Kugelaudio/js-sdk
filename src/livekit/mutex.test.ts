import { describe, expect, it } from 'vitest';

import { Mutex } from './mutex';

/** Resolve after `ms`, without keeping the process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

describe('Mutex', () => {
  it('serialises holders — only one at a time', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const first = await mutex.lock();
    const second = mutex.lock().then((release) => {
      order.push('second');
      release();
    });

    order.push('first');
    await sleep(10);
    expect(order).toEqual(['first']);

    first();
    await second;
    expect(order).toEqual(['first', 'second']);
  });

  it('rejects a waiter with APITimeoutError once its budget expires', async () => {
    const mutex = new Mutex();
    const release = await mutex.lock();

    const started = Date.now();
    await expect(mutex.lock(100)).rejects.toMatchObject({ name: 'APITimeoutError' });
    expect(Date.now() - started).toBeLessThan(1_000);

    release();
  });

  it('stays usable after a waiter times out (no permanent deadlock)', async () => {
    const mutex = new Mutex();
    const release = await mutex.lock();

    await expect(mutex.lock(50)).rejects.toThrow();
    release();

    // A chained-promise mutex would hang here forever: the abandoned waiter's
    // promise is still sitting in the chain.
    const next = await mutex.lock(1_000);
    expect(typeof next).toBe('function');
    next();
    (await mutex.lock(1_000))();
  });

  it('never hands the lock to a waiter that already timed out', async () => {
    const mutex = new Mutex();
    const release = await mutex.lock();

    const timedOut = mutex.lock(50).then(
      () => 'granted',
      () => 'rejected',
    );
    await expect(timedOut).resolves.toBe('rejected');

    let granted = false;
    const live = mutex.lock(1_000).then((r) => {
      granted = true;
      r();
    });
    release();
    await live;
    expect(granted).toBe(true);
  });

  it('has an idempotent release — a double call does not free the lock twice', async () => {
    const mutex = new Mutex();
    const release = await mutex.lock();

    const order: string[] = [];
    const a = mutex.lock().then((r) => {
      order.push('a');
      return r;
    });
    const b = mutex.lock().then((r) => {
      order.push('b');
      return r;
    });

    release();
    release(); // must be a no-op, not a second hand-off
    const aRelease = await a;

    await sleep(10);
    expect(order).toEqual(['a']);

    aRelease();
    (await b)();
    expect(order).toEqual(['a', 'b']);
  });

  it('waits indefinitely when no timeout is given', async () => {
    const mutex = new Mutex();
    const release = await mutex.lock();

    let acquired = false;
    const pending = mutex.lock().then((r) => {
      acquired = true;
      r();
    });

    await sleep(150);
    expect(acquired).toBe(false);

    release();
    await pending;
    expect(acquired).toBe(true);
  });
});
