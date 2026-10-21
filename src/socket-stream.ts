/**
 * Shared plumbing for the streaming WebSocket resources (`client.enhance`,
 * `client.asr`): a queue that hands socket events to an async generator, the
 * typed handshake, and frame parsing.
 */

import { ConnectionError, classifyWsClose, classifyWsHandshakeError } from './errors';
import { handshakeDeadline, handshakeRejectionOf } from './handshake';

export type StreamEvent =
  | { kind: 'message'; data: unknown }
  | { kind: 'close'; code?: number; reason?: string }
  | { kind: 'failure'; error: unknown };

/** Buffers socket events until the generator asks for the next one. */
export class EventQueue {
  private items: StreamEvent[] = [];
  private waiter: ((event: StreamEvent) => void) | null = null;

  push(event: StreamEvent): void {
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(event);
    } else {
      this.items.push(event);
    }
  }

  /** The next event; with `timeoutMs`, rejects with a `ConnectionError` carrying `timeoutMessage`. */
  next(timeoutMs?: number, timeoutMessage = 'The KugelAudio stream did not answer in time.'): Promise<StreamEvent> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiter = null;
          reject(new ConnectionError(timeoutMessage));
        }, timeoutMs);
      }
      this.waiter = (event) => {
        if (timer) clearTimeout(timer);
        resolve(event);
      };
    });
  }
}

/** Wait for `ws` to open; a refused upgrade or an early close rejects with its typed error. */
export function openSocket(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = handshakeDeadline(ws, timeoutMs, reject);
    ws.onopen = () => {
      if (deadline.opened()) resolve();
    };
    ws.onerror = (event: unknown) => {
      deadline.failed();
      // A refused upgrade: the kept rejection response, else the transport error.
      const failure =
        handshakeRejectionOf(ws) ?? (event as { error?: unknown } | null)?.error ?? event;
      reject(
        classifyWsHandshakeError(failure) ??
          new ConnectionError('KugelAudio WebSocket handshake failed.'),
      );
    };
    ws.onclose = (event: { code?: number; reason?: string }) => {
      deadline.failed();
      reject(classifyWsClose(event.code, event.reason));
    };
  });
}

/** A text frame's JSON object, or `{}` for anything else. */
export function parseText(data: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(data));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
