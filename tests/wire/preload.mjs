/**
 * DNS preload for the wire tests (`node --import ./preload.mjs child.mjs`).
 *
 * `*.kugelaudio.com` resolves to 127.0.0.1 so a child can reach the local test
 * server under a hosted name (the enablement default keys off the host), and
 * `*.invalid` fails at once with ENOTFOUND instead of depending on the
 * machine's resolver. Everything else resolves normally. Patching the `dns`
 * module object is enough: `net.connect` (fetch/undici, `ws`) looks up
 * `dns.lookup` at call time.
 */
import dns from 'node:dns';

const realLookup = dns.lookup;
const realPromiseLookup = dns.promises.lookup;

function route(hostname) {
  if (/\.kugelaudio\.com$/i.test(hostname)) return '127.0.0.1';
  if (/\.invalid$/i.test(hostname)) {
    return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
      code: 'ENOTFOUND',
      errno: -3008,
      syscall: 'getaddrinfo',
      hostname,
    });
  }
  return null;
}

dns.lookup = function lookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'object' && options !== null ? options : {};
  const routed = route(hostname);
  if (routed === null) return realLookup.call(dns, hostname, options, callback);
  process.nextTick(() => {
    if (routed instanceof Error) return cb(routed);
    if (opts.all) return cb(null, [{ address: routed, family: 4 }]);
    return cb(null, routed, 4);
  });
  return {};
};

dns.promises.lookup = async function lookup(hostname, options) {
  const routed = route(hostname);
  if (routed === null) return realPromiseLookup.call(dns.promises, hostname, options);
  if (routed instanceof Error) throw routed;
  return options?.all ? [{ address: routed, family: 4 }] : { address: routed, family: 4 };
};
