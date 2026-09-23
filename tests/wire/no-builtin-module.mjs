/**
 * Old-Node preload for the wire tests: removes `process.getBuiltinModule`
 * (Node >= 20.16 / 22.3) so the ESM build runs as it does on Node 18.x,
 * 20.0-20.15 and 22.0-22.2. Load after `preload.mjs`.
 */
delete process.getBuiltinModule;
