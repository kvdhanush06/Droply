import type {
  SignalingErrorCode,
  SignalingIncoming,
  SignalingOutgoing,
  SignalingState,
} from '../../types';

const ERROR_CODES = new Set([
  'PROTOCOL_ERROR',
  'MALFORMED_MESSAGE',
  'MESSAGE_TOO_LARGE',
  'RATE_LIMITED',
  'NOT_IN_ROOM',
  'ALREADY_IN_ROOM',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ROOM_LIMIT_REACHED',
  'UNKNOWN_PEER',
  'PEER_NOT_FOUND',
  'SERVER_SHUTTING_DOWN',
  'NAME_EXISTS',
]);

const PEER_ID_PATTERN = /^[A-Za-z0-9]{12}$/;
const ROOM_ID_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

/** Strictly validates a raw server message before it reaches app code. */
export function validateServerMessage(raw: unknown): SignalingIncoming | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string') return null;

  switch (msg.type) {
    case 'room-created':
      if (typeof msg.roomId !== 'string' || !ROOM_ID_PATTERN.test(msg.roomId)) return null;
      if (typeof msg.peerId !== 'string' || !PEER_ID_PATTERN.test(msg.peerId)) return null;
      return {
        type: 'room-created',
        roomId: msg.roomId,
        peerId: msg.peerId,
        expiresAt: typeof msg.expiresAt === 'number' ? msg.expiresAt : 0,
        deviceNames: Array.isArray(msg.deviceNames) ? msg.deviceNames.filter((n): n is string => typeof n === 'string') : undefined,
      };

    case 'room-joined': {
      if (typeof msg.roomId !== 'string' || !ROOM_ID_PATTERN.test(msg.roomId)) return null;
      if (typeof msg.peerId !== 'string' || !PEER_ID_PATTERN.test(msg.peerId)) return null;
      const peers = Array.isArray(msg.peers)
        ? msg.peers.filter((p): p is string => typeof p === 'string' && PEER_ID_PATTERN.test(p))
        : [];
      const deviceNames: Record<string, string> = {};
      if (typeof msg.deviceNames === 'object' && msg.deviceNames !== null) {
        for (const [id, name] of Object.entries(msg.deviceNames)) {
          if (typeof id === 'string' && typeof name === 'string' && PEER_ID_PATTERN.test(id)) {
            deviceNames[id] = name;
          }
        }
      }
      return {
        type: 'room-joined',
        roomId: msg.roomId,
        peerId: msg.peerId,
        peers,
        expiresAt: typeof msg.expiresAt === 'number' ? msg.expiresAt : 0,
        deviceNames,
      };
    }

    case 'peer-joined':
      if (typeof msg.peerId !== 'string' || !PEER_ID_PATTERN.test(msg.peerId)) return null;
      return {
        type: 'peer-joined',
        peerId: msg.peerId,
        ...(typeof msg.deviceName === 'string' && msg.deviceName.length > 0 && msg.deviceName.length <= 64
          ? { deviceName: msg.deviceName }
          : {}),
      };

    case 'peer-left':
      return typeof msg.peerId === 'string' && PEER_ID_PATTERN.test(msg.peerId)
        ? { type: 'peer-left', peerId: msg.peerId }
        : null;

    case 'signal': {
      if (typeof msg.from !== 'string' || !PEER_ID_PATTERN.test(msg.from)) return null;
      const signal: SignalingIncoming = { type: 'signal', from: msg.from };
      if (typeof msg.sdp === 'string') {
        if (msg.sdp.length > 32 * 1024) return null;
        (signal as { sdp?: string }).sdp = msg.sdp;
      }
      if (msg.candidate !== undefined) {
        (signal as { candidate?: unknown }).candidate = msg.candidate as RTCIceCandidateInit | null;
      }
      return signal;
    }

    case 'room-expired':
      return typeof msg.roomId === 'string' ? { type: 'room-expired', roomId: msg.roomId } : null;

    case 'error': {
      if (typeof msg.code !== 'string' || !ERROR_CODES.has(msg.code)) return null;
      const message = typeof msg.message === 'string' ? msg.message.slice(0, 500) : 'Something went wrong.';
      return {
        type: 'error',
        code: msg.code as SignalingErrorCode,
        message,
      };
    }

    default:
      return null;
  }
}

export interface SignalingClientEvents {
  onMessage: (message: SignalingIncoming) => void;
  onStateChange: (state: SignalingState) => void;
}

/**
 * Thin wrapper around the signaling WebSocket. It validates every incoming
 * frame, emits typed messages and exposes the connection state. It never
 * auto-reconnects: a disconnected socket means the room is gone server-side,
 * so the UI starts a fresh flow instead of silently reusing stale state.
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly events: SignalingClientEvents;
  private state: SignalingState = 'idle';
  private socketEpoch = 0;

  constructor(url: string, events: SignalingClientEvents) {
    this.url = url;
    this.events = events;
  }

  getState(): SignalingState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state === 'open' && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.state === 'open' || this.state === 'connecting') return;
    this.setState('connecting');
    const epoch = ++this.socketEpoch;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.setState('closed');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (epoch !== this.socketEpoch) return;
      this.setState('open');
    };

    ws.onmessage = (event) => {
      if (epoch !== this.socketEpoch) return;
      if (typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const message = validateServerMessage(parsed);
      if (message) this.events.onMessage(message);
    };

    ws.onclose = () => {
      if (epoch !== this.socketEpoch) return;
      this.ws = null;
      this.setState('closed');
    };

    ws.onerror = () => {
      // The subsequent 'close' event drives the state transition.
    };
  }

  send(message: SignalingOutgoing): boolean {
    if (!this.isOpen()) return false;
    try {
      this.ws!.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.socketEpoch += 1;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(1000, 'Client closing');
      } catch {
        /* already closed */
      }
    }
    if (this.state !== 'idle') this.setState('idle');
  }

  private setState(state: SignalingState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange(state);
  }
}
