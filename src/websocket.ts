/**
 * WebSocket compatibility layer for browser and Node.js environments.
 *
 * IMPORTANT: WebSocket resolution is lazy to avoid top-level side-effects
 * that break server-side bundlers (Turbopack / Webpack) when this module
 * is imported in a Node.js (API route) context.
 *
 * One resolver, in this order, cached after the first success:
 * 1. Node: the `ws` package through a synchronous `require` (CJS build, or
 *    the ESM build on Node >= 20.16 / 22.3).
 * 2. Node, ESM build without `process.getBuiltinModule` (18.x, 20.0-20.15,
 *    22.0-22.2): the `ws` package through an async `import('ws')`.
 * 3. The native `globalThis.WebSocket` (browser / edge / Deno, or Node
 *    without `ws` installed).
 *
 * Callers use {@link getWebSocket} for the synchronous answer and
 * `await loadWebSocket()` only when it returns `undefined` (step 2).
 */

import { importModule, isNodeJs, moduleUrl, nodeRequire } from './node-runtime';

// In Node we prefer the `ws` package because Node's built-in WebSocket (added
// in Node 22) surfaces a useless opaque message on handshake failures
// ("Received network error or non-101 status code"), whereas `ws` exposes the
// rejected HTTP status in the error, which the error classifier uses to raise
// `AuthenticationError` / `RateLimitError` etc.

type WebSocketCtor = typeof WebSocket;

let _cachedWs: WebSocketCtor | null = null;
let _loading: Promise<WebSocketCtor> | null = null;

/** The constructor from a `require('ws')` or `import('ws')` namespace. */
function wsConstructor(mod: unknown): WebSocketCtor {
    const ws = mod as { default?: WebSocketCtor } & WebSocketCtor;
    return ws.default || ws;
}

function nativeWebSocket(): WebSocketCtor {
    const native = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (native) return native;
    throw new Error(
        'WebSocket not available. In Node.js, install the "ws" package: npm install ws'
    );
}

/**
 * Get the WebSocket constructor for the current environment, synchronously.
 * Prefers the `ws` package in Node.js (for richer handshake errors), falls
 * back to the native `globalThis.WebSocket` elsewhere. Cached.
 *
 * Returns `undefined` only in the ESM build on a Node without
 * `process.getBuiltinModule`: there `ws` needs `await loadWebSocket()` first,
 * after which this returns the cached constructor. Throws when no WebSocket
 * exists at all.
 */
export function getWebSocket(): WebSocketCtor | undefined {
    if (_cachedWs) return _cachedWs;

    if (isNodeJs()) {
        const _require = nodeRequire();
        if (_require) {
            try {
                _cachedWs = wsConstructor(_require('ws'));
                return _cachedWs;
            } catch {
                // KEEP-JUSTIFIED: `ws` isn't installed; the native WebSocket
                // below still works, only with poorer handshake errors.
            }
        } else if (moduleUrl()) {
            return undefined; // ESM without a sync require: loadWebSocket()
        }
    }

    _cachedWs = nativeWebSocket();
    return _cachedWs;
}

/**
 * Resolve the WebSocket constructor, importing `ws` asynchronously where no
 * synchronous `require` exists (see {@link getWebSocket}). Cached; a failed
 * attempt is retried on the next call.
 */
export function loadWebSocket(): Promise<WebSocketCtor> {
    const now = getWebSocket();
    if (now) return Promise.resolve(now);
    _loading ??= importModule('ws')
        // KEEP-JUSTIFIED: `ws` isn't installed; same native fallback as above.
        .then(wsConstructor, () => nativeWebSocket())
        .then(
            (ws) => (_cachedWs = ws),
            (error: unknown) => {
                _loading = null;
                throw error;
            },
        );
    return _loading;
}
