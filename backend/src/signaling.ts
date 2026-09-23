import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { RoomManager } from './rooms.js';
import {
  parseClientMessage,
  serializeMessage,
  type ErrorCode,
  type ServerMessage,
  type ValidClientMessage,
} from './protocol.js';
import { KeyedRateLimiter, TokenBucket } from './rateLimit.js';

const WS_OPEN = 1;

interface ClientState {
  ws: WebSocket;
  ip: string;
  peerId: string | null;
  roomId: string | null;
  /** Sanitized device name for the current room membership (display only). */
  deviceName: string | null;
  messageBucket: TokenBucket;
  malformedCount: number;
  isAlive: boolean;
}

export interface SignalingOptions {
  config: AppConfig;
  rooms: RoomManager;
  logger: Logger;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]!.trim();
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Hostnames a browser may use on the operator's own machine or LAN: loopback
 * (localhost / 127.x / ::1), private ranges (10.x, 172.16-31.x, 192.168.x),
 * link-local and mDNS `.local` names. Covers phone-on-hotspot access, where
 * the page's Origin (http://192.168.43.101:5000) differs from the backend's
 * Host (…:3000) because of the dev proxy.
 */
function isLocalOrPrivate(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fe80:')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return false;
    const [a = -1, b = -1] = octets;
    if (a === 127) return true; // loopback
    if (a === 10 || a === 192) return true; // 10.0.0.0/8, 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}

export function isOriginAllowed(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  config: AppConfig,
): boolean {
  if (!originHeader) return true; // Non-browser clients send no Origin header.
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (config.allowedOrigins.includes(origin.origin)) return true;
  if (hostHeader && origin.host === hostHeader) return true;
  if (config.allowLocalhostOrigins && isLocalOrPrivate(origin.hostname)) return true;
  return false;
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export class SignalingServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientState>();
  private readonly byPeer = new Map<string, ClientState>();
  private readonly config: AppConfig;
  private readonly rooms: RoomManager;
  private readonly logger: Logger;
  private readonly connectionLimiter: KeyedRateLimiter;
  private readonly roomCreateLimiter: KeyedRateLimiter;
  private readonly roomJoinLimiter: KeyedRateLimiter;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: SignalingOptions) {
    this.config = options.config;
    this.rooms = options.rooms;
    this.logger = options.logger;
    this.connectionLimiter = new KeyedRateLimiter(this.config.rateLimits.connectionsPerMinute);
    this.roomCreateLimiter = new KeyedRateLimiter(this.config.rateLimits.roomCreatesPerMinute);
    this.roomJoinLimiter = new KeyedRateLimiter(this.config.rateLimits.roomJoinsPerMinute);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.config.maxWsMessageBytes });

    this.rooms.setRoomExpiredHandler((roomId, peerIds) => {
      for (const peerId of peerIds) {
        const client = this.byPeer.get(peerId);
        if (client && client.roomId === roomId) {
          this.send(client, { type: 'room-expired', roomId });
          client.roomId = null;
          client.peerId = null;
          client.deviceName = null;
          this.byPeer.delete(peerId);
        }
      }
    });

    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  /** Called from the HTTP server's 'upgrade' event. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, '404 Not Found');
      return;
    }
    const ip = clientIp(req, this.config.trustProxy);
    if (!isOriginAllowed(req.headers.origin, req.headers.host, this.config)) {
      this.logger.warn('ws_origin_rejected', { ip });
      rejectUpgrade(socket, '403 Forbidden');
      return;
    }
    if (this.clients.size >= this.config.maxConnections) {
      rejectUpgrade(socket, '503 Service Unavailable');
      return;
    }
    if (!this.connectionLimiter.allow(ip)) {
      this.logger.warn('ws_rate_limited', { ip, kind: 'connect' });
      rejectUpgrade(socket, '429 Too Many Requests');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const state: ClientState = {
      ws,
      ip,
      peerId: null,
      roomId: null,
      deviceName: null,
      messageBucket: new TokenBucket(
        this.config.rateLimits.messagesPerSecond * 2,
        this.config.rateLimits.messagesPerSecond,
      ),
      malformedCount: 0,
      isAlive: true,
    };
    this.clients.add(state);
    this.logger.debug('ws_connected', { ip, connections: this.clients.size });

    ws.on('pong', () => {
      state.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.onBadMessage(state, 'PROTOCOL_ERROR', 'Binary frames are not part of the signaling protocol.');
        return;
      }
      const raw = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
      const parsed = parseClientMessage(raw, this.config.maxWsMessageBytes);
      if (!parsed.ok) {
        this.onBadMessage(state, parsed.code, parsed.message);
        return;
      }
      // Validate before spending rate budget: malformed or out-of-room frames
      // fail fast without draining the bucket, so a few stray frames can
      // never trip the flood guard on a healthy connection.
      if (!this.isRoutable(state, parsed.message)) return;
      if (!state.messageBucket.tryConsume(Date.now())) {
        this.send(state, { type: 'error', code: 'RATE_LIMITED', message: 'You are sending messages too quickly.' });
        return;
      }
      this.dispatch(state, parsed.message);
    });

    ws.on('close', () => this.onDisconnect(state));
    ws.on('error', () => {
      // Cleanup happens in the 'close' handler.
    });
  }

  /**
   * Fails a message fast without spending rate budget when it can never be
   * routed: create/join while already in a room, or signaling from a socket
   * that is not in a room (or toward an unknown peer). Returns true when the
   * message is routable and dispatch may proceed.
   */
  private isRoutable(state: ClientState, message: ValidClientMessage): boolean {
    switch (message.kind) {
      case 'create-room':
      case 'join-room':
        if (state.roomId !== null) {
          this.send(state, { type: 'error', code: 'ALREADY_IN_ROOM', message: 'Leave the current room before joining a new one.' });
          return false;
        }
        return true;
      case 'signal': {
        if (state.roomId === null || state.peerId === null) {
          this.send(state, { type: 'error', code: 'NOT_IN_ROOM', message: 'Join a room before exchanging signals.' });
          return false;
        }
        const room = this.rooms.getRoom(state.roomId);
        if (!room || !room.peers.has(message.to) || !this.byPeer.has(message.to)) {
          this.send(state, { type: 'error', code: 'PEER_NOT_FOUND', message: 'That peer is no longer available.' });
          return false;
        }
        return true;
      }
    }
  }

  private dispatch(state: ClientState, message: ValidClientMessage): void {
    switch (message.kind) {
      case 'create-room':
        this.onCreateRoom(state, message.deviceName);
        return;
      case 'join-room':
        this.onJoinRoom(state, message.roomId, message.deviceName);
        return;
      case 'signal':
        this.onSignal(state, message);
        return;
    }
  }

  private onCreateRoom(state: ClientState, deviceName?: string): void {
    if (state.roomId !== null) {
      this.send(state, { type: 'error', code: 'ALREADY_IN_ROOM', message: 'Leave the current room before creating a new one.' });
      return;
    }
    if (!this.roomCreateLimiter.allow(state.ip)) {
      this.send(state, { type: 'error', code: 'RATE_LIMITED', message: 'Too many rooms created. Please wait a moment.' });
      return;
    }
    const peerId = this.rooms.generatePeerId();
    const name = deviceName ?? 'Unknown Device';
    const room = this.rooms.createRoom(peerId, name);
    if (!room) {
      this.send(state, { type: 'error', code: 'ROOM_LIMIT_REACHED', message: 'The server is busy. Please try again shortly.' });
      return;
    }
    state.peerId = peerId;
    state.roomId = room.id;
    state.deviceName = name;
    this.byPeer.set(peerId, state);
    const deviceNames = [...room.peers.values()];
    this.send(state, { type: 'room-created', roomId: room.id, peerId, expiresAt: room.expiresAt, deviceNames });
  }

  private onJoinRoom(state: ClientState, roomId: string, deviceName?: string): void {
    if (state.roomId !== null) {
      this.send(state, { type: 'error', code: 'ALREADY_IN_ROOM', message: 'Leave the current room before joining a new one.' });
      return;
    }
    if (!this.roomJoinLimiter.allow(state.ip)) {
      this.send(state, { type: 'error', code: 'RATE_LIMITED', message: 'Too many join attempts. Please wait a moment.' });
      return;
    }
    const name = deviceName ?? 'Unknown Device';
    const peerId = this.rooms.generatePeerId();
    const result = this.rooms.joinRoom(roomId, peerId, name);
    if (result === 'not-found') {
      this.send(state, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'No room with that code exists. It may have expired.' });
      return;
    }
    if (result === 'name-exists') {
      this.send(state, {
        type: 'error',
        code: 'NAME_EXISTS',
        message: `The name “${name}” is already used by another device in this room. Choose a different name.`,
      });
      return;
    }
    if (result === 'full') {
      this.send(state, { type: 'error', code: 'ROOM_FULL', message: 'That room already has the maximum number of devices.' });
      return;
    }
    const room = this.rooms.getRoom(roomId);
    if (!room) {
      // Expired between the join call and now; treat as not found.
      this.send(state, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'No room with that code exists. It may have expired.' });
      return;
    }
    state.peerId = peerId;
    state.roomId = roomId;
    state.deviceName = name;
    this.byPeer.set(peerId, state);

    const existingPeers = [...room.peers.keys()].filter((id) => id !== peerId);
    const deviceNames: Record<string, string> = {};
    for (const [id, peerName] of room.peers) {
      deviceNames[id] = peerName;
    }
    this.send(state, { type: 'room-joined', roomId, peerId, peers: existingPeers, deviceNames, expiresAt: room.expiresAt });
    for (const otherId of existingPeers) {
      const other = this.byPeer.get(otherId);
      if (other) this.send(other, { type: 'peer-joined', peerId, deviceName: name });
    }
  }

  private onSignal(state: ClientState, message: { to: string; sdp?: string; candidate?: unknown }): void {
    if (state.roomId === null || state.peerId === null) {
      this.send(state, { type: 'error', code: 'NOT_IN_ROOM', message: 'Join a room before exchanging signals.' });
      return;
    }
    const room = this.rooms.getRoom(state.roomId);
    if (!room || !room.peers.has(message.to)) {
      this.send(state, { type: 'error', code: 'PEER_NOT_FOUND', message: 'That peer is no longer in the room.' });
      return;
    }
    const target = this.byPeer.get(message.to);
    if (!target) {
      this.send(state, { type: 'error', code: 'PEER_NOT_FOUND', message: 'That peer is no longer connected.' });
      return;
    }
    const outbound: ServerMessage = { type: 'signal', from: state.peerId };
    if (message.sdp !== undefined) outbound.sdp = message.sdp;
    if (message.candidate !== undefined) outbound.candidate = message.candidate;
    this.send(target, outbound);
    this.rooms.touch(room);
  }

  private leaveCurrentRoom(state: ClientState): void {
    if (state.roomId === null || state.peerId === null) return;
    const roomId = state.roomId;
    const peerId = state.peerId;
    const result = this.rooms.leaveRoom(roomId, peerId);
    state.roomId = null;
    state.peerId = null;
    state.deviceName = null;
    this.byPeer.delete(peerId);
    if (result) {
      for (const otherId of result.remaining) {
        const other = this.byPeer.get(otherId);
        if (other) this.send(other, { type: 'peer-left', peerId });
      }
    }
  }

  private onDisconnect(state: ClientState): void {
    this.leaveCurrentRoom(state);
    this.clients.delete(state);
    this.logger.debug('ws_disconnected', { connections: this.clients.size });
  }

  private onBadMessage(state: ClientState, code: ErrorCode, message: string): void {
    state.malformedCount += 1;
    this.send(state, { type: 'error', code, message });
    if (state.malformedCount >= this.config.maxMalformedMessages) {
      this.logger.warn('ws_closed_malformed', { ip: state.ip });
      state.ws.close(1003, 'Too many invalid messages');
    }
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ws.ping();
      } catch {
        client.ws.terminate();
      }
    }
  }

  private send(state: ClientState, message: ServerMessage): void {
    if (state.ws.readyState === WS_OPEN) {
      state.ws.send(serializeMessage(message));
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  /** Stops heartbeats and closes every connection gracefully. */
  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients) {
      try {
        client.ws.close(1001, 'Server shutting down');
      } catch {
        client.ws.terminate();
      }
    }
    this.clients.clear();
    this.byPeer.clear();
    this.wss.close();
  }
}
