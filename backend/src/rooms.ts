import { randomBytes } from 'node:crypto';
import { generateRoomId } from './roomId.js';
import { PEER_ID_LENGTH } from './protocol.js';
import type { Logger } from './logger.js';

const PEER_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export interface Room {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  peers: Map<string, string>; // peerId -> deviceName
}

export interface RoomManagerOptions {
  ttlMs: number;
  maxRoomPeers: number;
  maxRooms: number;
  sweepIntervalMs: number;
  logger: Logger;
  now?: () => number;
  sweep?: boolean;
}

export type JoinResult = 'ok' | 'not-found' | 'full' | 'limit' | 'name-exists';

/**
 * In-memory registry of ephemeral rooms. Rooms expire after `ttlMs` of
 * inactivity and are removed immediately once the last peer leaves. Nothing
 * is persisted and no payload data ever passes through here — only peer ids.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly ttlMs: number;
  private readonly maxRoomPeers: number;
  private readonly maxRooms: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private onRoomExpired: ((roomId: string, peerIds: string[]) => void) | null = null;

  constructor(options: RoomManagerOptions) {
    this.ttlMs = options.ttlMs;
    this.maxRoomPeers = options.maxRoomPeers;
    this.maxRooms = options.maxRooms;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    if (options.sweep !== false) {
      this.sweepTimer = setInterval(() => this.sweepExpired(), options.sweepIntervalMs);
      this.sweepTimer.unref();
    }
  }

  setRoomExpiredHandler(handler: (roomId: string, peerIds: string[]) => void): void {
    this.onRoomExpired = handler;
  }

  generatePeerId(): string {
    const bytes = randomBytes(PEER_ID_LENGTH);
    let id = '';
    for (let i = 0; i < PEER_ID_LENGTH; i += 1) {
      id += PEER_ID_ALPHABET[bytes[i]! % PEER_ID_ALPHABET.length];
    }
    return id;
  }

  createRoom(peerId: string, deviceName: string): Room | null {
    if (this.rooms.size >= this.maxRooms) {
      this.logger.warn('room_limit_reached', { rooms: this.rooms.size });
      return null;
    }
    let id = generateRoomId();
    // Astronomically unlikely, but never hand out a duplicate.
    for (let attempts = 0; attempts < 8 && this.rooms.has(id); attempts += 1) {
      id = generateRoomId();
    }
    if (this.rooms.has(id)) return null;

    const now = this.now();
    const room: Room = {
      id,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + this.ttlMs,
      peers: new Map([[peerId, deviceName]]),
    };
    this.rooms.set(id, room);
    this.logger.info('room_created', { room: id });
    return room;
  }

  /**
   * Case-insensitive uniqueness is enforced here, at the single point of
   * truth for room membership, so two devices can never present the same
   * name inside one room.
   */
  private static hasNameTaken(peers: Map<string, string>, deviceName: string): boolean {
    const wanted = deviceName.trim().toLowerCase();
    for (const name of peers.values()) {
      if (name.trim().toLowerCase() === wanted) return true;
    }
    return false;
  }

  joinRoom(roomId: string, peerId: string, deviceName: string): JoinResult {
    const room = this.rooms.get(roomId);
    if (!room) return 'not-found';

    // Device names must be unique within a room (checked case-insensitively).
    // Evaluated before the capacity check so the conflict is always what the
    // user is told about.
    if (RoomManager.hasNameTaken(room.peers, deviceName)) {
      this.logger.info('room_join_name_conflict', { room: roomId });
      return 'name-exists';
    }

    if (!room.peers.has(peerId) && room.peers.size >= this.maxRoomPeers) return 'full';
    room.peers.set(peerId, deviceName);
    this.touch(room);
    this.logger.info('room_joined', { room: roomId, peers: room.peers.size });
    return 'ok';
  }

  leaveRoom(roomId: string, peerId: string): { remaining: string[]; remainingNames: Map<string, string> } | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.peers.delete(peerId);
    if (room.peers.size === 0) {
      this.rooms.delete(roomId);
      this.logger.info('room_closed', { room: roomId, reason: 'empty' });
      return { remaining: [], remainingNames: new Map() };
    }
    this.touch(room);
    this.logger.info('peer_left', { room: roomId, peers: room.peers.size });
    return {
      remaining: [...room.peers.keys()],
      remainingNames: new Map(room.peers),
    };
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  touch(room: Room): void {
    const now = this.now();
    room.lastActivityAt = now;
    room.expiresAt = now + this.ttlMs;
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Removes rooms whose TTL has elapsed. Returns the expired room ids. */
  sweepExpired(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const [id, room] of this.rooms) {
      if (room.expiresAt <= now) {
        this.rooms.delete(id);
        expired.push(id);
        this.logger.info('room_expired', { room: id });
        this.onRoomExpired?.(id, [...room.peers.keys()]);
      }
    }
    return expired;
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.rooms.clear();
  }
}
