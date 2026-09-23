import type { IceServerConfig, ServerPublicConfig } from '../types';

/**
 * Runtime configuration. ICE servers are fetched from the backend so STUN/TURN
 * can be configured with environment variables without rebuilding the bundle.
 */
const FALLBACK_ICE_SERVERS: IceServerConfig[] = [{ urls: ['stun:stun.l.google.com:19302'] }];

const FALLBACK_CONFIG: ServerPublicConfig = {
  iceServers: FALLBACK_ICE_SERVERS,
  maxRoomPeers: 4,
  roomTtlSeconds: 1800,
};

let cached: Promise<ServerPublicConfig> | null = null;

function sanitizeIceServers(raw: unknown): IceServerConfig[] {
  if (!Array.isArray(raw)) return FALLBACK_ICE_SERVERS;
  const servers: IceServerConfig[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const urls = record.urls;
    const valid =
      typeof urls === 'string'
        ? urls.startsWith('stun:') || urls.startsWith('turn:') || urls.startsWith('turns:')
        : Array.isArray(urls) && urls.every((u) => typeof u === 'string');
    if (!valid) continue;
    const server: IceServerConfig = { urls: urls as string | string[] };
    if (typeof record.username === 'string' && typeof record.credential === 'string') {
      server.username = record.username;
      server.credential = record.credential;
    }
    servers.push(server);
  }
  return servers.length > 0 ? servers : FALLBACK_ICE_SERVERS;
}

export async function loadServerConfig(): Promise<ServerPublicConfig> {
  cached ??= fetch('/api/config', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`config ${res.status}`))))
    .then((data: unknown) => {
      const record = (data ?? {}) as Record<string, unknown>;
      return {
        iceServers: sanitizeIceServers(record.iceServers),
        maxRoomPeers: typeof record.maxRoomPeers === 'number' ? record.maxRoomPeers : FALLBACK_CONFIG.maxRoomPeers,
        roomTtlSeconds:
          typeof record.roomTtlSeconds === 'number' ? record.roomTtlSeconds : FALLBACK_CONFIG.roomTtlSeconds,
      } satisfies ServerPublicConfig;
    })
    .catch(() => FALLBACK_CONFIG);
  return cached;
}

/** WebSocket URL for the signaling endpoint, derived from the current page. */
export function signalingUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function isWebRtcSupported(): boolean {
  return (
    typeof RTCPeerConnection !== 'undefined' &&
    typeof RTCPeerConnection.prototype.createDataChannel === 'function'
  );
}
