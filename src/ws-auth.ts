/**
 * How a socket presents the client's credential.
 *
 * An API key or a token rides the query string (`api_key=` / `token=`),
 * because a browser cannot set headers on a WebSocket upgrade. A master key
 * is sent only as an `Authorization: Bearer` header, so it never appears in a
 * URL; that needs Node.js (the `ws` package and Node's own WebSocket both
 * take upgrade headers). Every socket the SDK opens goes through
 * {@link masterKeyHeaders} and {@link newWebSocket}.
 */

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
  /** Upgrade headers; set only for a master key. */
  headers?: Record<string, string>;
}

/** A socket to open: its URL and, for a master key, its upgrade headers. */
export interface SocketTarget {
  url: string;
  headers?: Record<string, string>;
}

/**
 * The upgrade headers that carry a master key, or `undefined` when the
 * client's credential rides the query (an API key or a token).
 */
export function masterKeyHeaders(client: CredentialSource): Record<string, string> | undefined {
  if (client.isToken || !client.isMasterKey) return undefined;
  if (!isNodeJs()) {
    throw new KugelAudioError(
      'isMasterKey needs Node.js: the master key is sent as a WebSocket header, which browsers cannot set',
    );
  }
  return { Authorization: `Bearer ${client.apiKey}` };
}

/** The TTS sockets' credential: `token=`, `api_key=`, or the master-key header. */
export function socketCredential(client: CredentialSource): SocketCredential {
  if (client.isToken) return { query: `token=${client.apiKey}` };
  const headers = masterKeyHeaders(client);
  if (headers) return { query: '', headers };
  return { query: `api_key=${client.apiKey}` };
}

/** `base` with the credential's query pair appended, when it has one. */
export function withCredentialQuery(base: string, credential: SocketCredential): string {
  return credential.query ? `${base}?${credential.query}` : base;
}

/** The Node WebSocket constructors' non-standard form that takes upgrade headers. */
type NodeWebSocketCtor = new (url: string, options: { headers: Record<string, string> }) => WebSocket;

/**
 * Construct a socket; `headers` (set only on Node, by {@link masterKeyHeaders})
 * go on the upgrade request as the second constructor argument.
 */
export function newWebSocket(
  WS: typeof WebSocket,
  url: string,
  headers: Record<string, string> | undefined,
): WebSocket {
  return headers ? new (WS as unknown as NodeWebSocketCtor)(url, { headers }) : new WS(url);
}
