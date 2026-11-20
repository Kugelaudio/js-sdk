import { KugelAudioError } from './errors';
import { isNodeJs } from './node-runtime';

/** The credential fields of a client. */
export interface CredentialSource {
  readonly apiKey: string;
  readonly isToken: boolean;
  readonly isMasterKey: boolean;
}

/** A socket's credential: a query pair, or upgrade headers. */
export interface SocketCredential {
  /** `name=value` for the socket URL; empty when the credential is a header. */
  query: string;
  /** Upgrade headers for a Node.js WebSocket. */
  headers?: Record<string, string>;
}

/** A socket to open: its URL and optional upgrade headers. */
export interface SocketTarget {
  url: string;
  headers?: Record<string, string>;
}

let warnedAboutBrowserKey = false;

/** Credentials for a WebSocket upgrade across Node.js and browser runtimes. */
export function socketCredential(client: CredentialSource): SocketCredential {
  if (client.isToken) return { query: `token=${encodeURIComponent(client.apiKey)}` };
  if (isNodeJs()) return { query: '', headers: { Authorization: `Bearer ${client.apiKey}` } };
  if (client.isMasterKey) {
    throw new KugelAudioError(
      'isMasterKey needs Node.js: the master key is sent as a WebSocket header, which browsers cannot set',
    );
  }
  if (!warnedAboutBrowserKey) {
    warnedAboutBrowserKey = true;
    console.warn(
      '[KugelAudio] API key authentication for browser WebSockets is deprecated. ' +
        'Use a short-lived JWT with isToken: true.',
    );
  }
  return { query: `api_key=${encodeURIComponent(client.apiKey)}` };
}

/** `base` with the credential's query pair appended, when it has one. */
export function withCredentialQuery(base: string, credential: SocketCredential): string {
  return credential.query ? `${base}?${credential.query}` : base;
}

/** The Node WebSocket constructors' non-standard form that takes upgrade headers. */
type NodeWebSocketCtor = new (url: string, options: { headers: Record<string, string> }) => WebSocket;

/**
 * Construct a socket; `headers` (set only on Node, by {@link socketCredential})
 * go on the upgrade request as the second constructor argument.
 */
export function newWebSocket(
  WS: typeof WebSocket,
  url: string,
  headers: Record<string, string> | undefined,
): WebSocket {
  return headers ? new (WS as unknown as NodeWebSocketCtor)(url, { headers }) : new WS(url);
}
