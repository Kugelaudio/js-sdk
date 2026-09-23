/**
 * Async mutex used by the LiveKit plugin to serialise `/ws/tts/multi`
 * connection (re)creation.
 *
 * Kept in its own module so the locking semantics can be unit-tested without
 * the LiveKit runtime's WebSocket machinery.
 */

import { APITimeoutError } from '@livekit/agents';

interface MutexWaiter {
  grant: (release: () => void) => void;
  timer?: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

/**
 * Async mutex with a **cancellable** wait: `lock(timeoutMs)` rejects with
 * {@link APITimeoutError} if the lock is not acquired in time, removing its
 * waiter from the queue so the mutex stays usable.
 *
 * Deliberately queue-based rather than the simpler chained-promise
 * (`tail = tail.then(...)`) form: abandoning a chained wait leaves its `next`
 * promise in the chain forever, which deadlocks the mutex permanently — so a
 * chained mutex cannot support timeouts at all.
 *
 * Serialises connection (re)creation so a burst of concurrent synthesis calls
 * opens only one WebSocket.
 */
export class Mutex {
  #locked = false;
  #waiters: MutexWaiter[] = [];

  /**
   * Acquire the lock.
   *
   * @param timeoutMs - Maximum time to wait for the lock. Omitted/undefined
   *   waits indefinitely.
   * @returns An idempotent release function.
   * @throws {APITimeoutError} If the lock was not acquired within `timeoutMs`.
   */
  async lock(timeoutMs?: number, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (!this.#locked) {
      this.#locked = true;
      return this.#makeRelease();
    }
    return new Promise<() => void>((resolve, reject) => {
      const abandon = (error: Error) => {
        const index = this.#waiters.indexOf(waiter);
        if (index === -1) return;
        this.#waiters.splice(index, 1);
        waiter.cleanup();
        reject(error);
      };
      const onAbort = () => abandon(signal!.reason);
      const waiter: MutexWaiter = {
        grant: resolve,
        cleanup: () => {
          clearTimeout(waiter.timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
        const timer = setTimeout(() => {
          abandon(
            new APITimeoutError({
              message: `Timed out after ${timeoutMs}ms waiting for the KugelAudio connection lock`,
            }),
          );
        }, Math.max(0, timeoutMs));
        // Never keep the event loop (and therefore the host process) alive.
        timer.unref?.();
        waiter.timer = timer;
      }
      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Build an idempotent release that hands ownership straight to the next waiter. */
  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (!next) {
        this.#locked = false;
        return;
      }
      next.cleanup();
      // `#locked` stays true: ownership transfers directly, never reopening
      // the door for a caller that arrives between release and grant.
      next.grant(this.#makeRelease());
    };
  }
}
