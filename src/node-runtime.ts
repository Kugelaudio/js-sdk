/**
 * Node.js module access for both builds without a static import a browser
 * bundler would follow. The one route for loading `ws` (websocket.ts) and
 * `node:stream` (`toReadable()`).
 */

/** Whether we run in Node.js (vs. browser / edge / Deno). */
export function isNodeJs(): boolean {
    return (
        typeof process !== 'undefined' &&
        !!process.versions &&
        typeof process.versions.node === 'string'
    );
}

type NodeRequire = (id: string) => unknown;

/** This module's URL in the ESM build; unused (and empty) in the CJS build. */
export function moduleUrl(): string | undefined {
    try {
        return import.meta.url;
    } catch {
        return undefined;
    }
}

/**
 * A synchronous `require`; `undefined` when none exists.
 *
 * - ESM (`dist/index.mjs`): only `module.createRequire(import.meta.url)`,
 *   fetching `module` through `process.getBuiltinModule` (Node >= 20.16 /
 *   22.3) rather than an `import` statement. Never the bare `require`: esbuild
 *   turns it into a `__require` shim that passes `typeof require ===
 *   'function'` and then throws. Without `getBuiltinModule` (Node 18.x,
 *   20.0-20.15, 22.0-22.2) there is none: use {@link importModule}.
 * - CJS (`dist/index.js`): `import.meta.url` is empty there, so the
 *   module's own `require`.
 */
export function nodeRequire(): NodeRequire | undefined {
    const from = moduleUrl();
    if (from) {
        const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown })
            .getBuiltinModule;
        if (typeof getBuiltin !== 'function') return undefined;
        const mod = getBuiltin('node:module') as
            | { createRequire?: (from: string) => NodeRequire }
            | undefined;
        return mod?.createRequire?.(from);
    }
    return typeof require === 'function' ? require : undefined;
}

/**
 * `import(specifier)` that bundlers leave alone: the specifier is a variable
 * (esbuild keeps it as is) and the magic comments stop webpack / Turbopack /
 * Vite from turning it into a context module. Only reached on Node.
 */
export function importModule(specifier: string): Promise<unknown> {
    return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier);
}

/**
 * `node:stream`'s `Readable`, synchronously, for the synchronous public
 * `toReadable()`. Throws where no synchronous `require` exists (the ESM build
 * on Node 18.x, 20.0-20.15, 22.0-22.2): an `import()` cannot answer a
 * synchronous call.
 */
export function nodeReadable(): typeof import('stream').Readable {
    const _require = isNodeJs() ? nodeRequire() : undefined;
    if (!_require) {
        throw new Error(
            'toReadable() needs Node.js with a synchronous require: Node >= 20.16 / 22.3 for ' +
                'the ESM build, or the CommonJS build (require("kugelaudio")) on older Node.'
        );
    }
    return (_require('stream') as typeof import('stream')).Readable;
}
