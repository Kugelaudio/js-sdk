import { ConnectionError } from './errors';

/** Bound opening only; traffic cannot reset the deadline or extend synthesis. */
export function handshakeDeadline(
  ws: WebSocket,
  timeoutMs: number,
  reject: (error: Error) => void,
): { opened: () => boolean; failed: () => void } {
  const deadline = performance.now() + timeoutMs;
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(new ConnectionError(`WebSocket opening handshake timed out after ${timeoutMs}ms`));
    ws.close();
  };
  const timer = setTimeout(fail, timeoutMs);
  timer.unref?.();
  return {
    opened() {
      if (settled) return false;
      if (performance.now() >= deadline) { fail(); return false; }
      settled = true;
      clearTimeout(timer);
      return true;
    },
    failed() {
      settled = true;
      clearTimeout(timer);
    },
  };
}

/** A rejected WebSocket upgrade: its HTTP status and response headers. */
export interface HandshakeRejection {
  statusCode: number;
  message: string;
  headers: Record<string, string | string[] | undefined>;
}

const rejections = new WeakMap<object, HandshakeRejection>();

interface NodeWsLike {
  on(event: 'unexpected-response', listener: (req: unknown, res: {
    statusCode?: number;
    headers?: Record<string, string | string[] | undefined>;
  }) => void): unknown;
  terminate(): void;
}

/**
 * Keep the rejection response of a refused upgrade (401, 429, connection cap).
 *
 * The `ws` package reports a refused upgrade only as the error message
 * `"Unexpected server response: 401"`: the response, and with it the
 * `x-request-id` ingress put on it, is discarded. Listening for
 * `unexpected-response` keeps both; the listener then aborts the handshake
 * with `terminate()`, which emits the same single `error` + `close` pair `ws`
 * emits on its own. A browser `WebSocket` exposes no rejection response at
 * all, so there this is a no-op.
 */
export function captureHandshakeRejection(ws: WebSocket): void {
  const node = ws as unknown as Partial<NodeWsLike>;
  if (typeof node.on !== 'function' || typeof node.terminate !== 'function') return;
  node.on.call(ws, 'unexpected-response', (_req, res) => {
    const statusCode = res.statusCode ?? 0;
    rejections.set(ws, {
      statusCode,
      message: `Unexpected server response: ${statusCode}`,
      headers: res.headers ?? {},
    });
    (ws as unknown as NodeWsLike).terminate();
  });
}

/** The rejection {@link captureHandshakeRejection} recorded for `ws`, if any. */
export function handshakeRejectionOf(ws: WebSocket): HandshakeRejection | undefined {
  return rejections.get(ws);
}
