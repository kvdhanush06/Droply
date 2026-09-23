import { describe, expect, it } from 'vitest';
import { RoomManager } from '../src/rooms.js';
import { createSilentLogger } from '../src/logger.js';

function makeManager(overrides: Partial<ConstructorParameters<typeof RoomManager>[0]> = {}) {
  let now = 1_000_000;
  const manager = new RoomManager({
    ttlMs: 30_000,
    maxRoomPeers: 2,
    maxRooms: 100,
    sweepIntervalMs: 60_000,
    logger: createSilentLogger(),
    now: () => now,
    sweep: false,
    ...overrides,
  });
  return { manager, advance: (ms: number) => { now += ms; } };
}

describe('RoomManager', () => {
  it('creates rooms with one member and returns the room', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('peerA', 'Host')!;
    expect(room.id).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect([...room.peers.entries()]).toEqual([['peerA', 'Host']]);
    expect(manager.size).toBe(1);
  });

  it('lets a second peer join and tracks activity', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('peerA', 'Host')!;
    expect(manager.joinRoom(room.id, 'peerB', 'Joiner')).toBe('ok');
    expect(manager.getRoom(room.id)!.peers.size).toBe(2);
  });

  it('rejects duplicate device names case-insensitively', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('peerA', 'KVD 1')!;
    expect(manager.joinRoom(room.id, 'peerB', 'kvd 1')).toBe('name-exists');
    expect(manager.joinRoom(room.id, 'peerB', '  KVD 1 ')).toBe('name-exists');
    expect(manager.joinRoom(room.id, 'peerB', 'KVD 2')).toBe('ok');
  });

  it('frees a name once its device leaves the room', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('peerA', 'KVD 1')!;
    manager.joinRoom(room.id, 'peerB', 'KVD 2');
    manager.leaveRoom(room.id, 'peerA');
    // peerA is gone: its name may be reused by the next device.
    expect(manager.joinRoom(room.id, 'peerC', 'KVD 1')).toBe('ok');
  });

  it('rejects joining unknown or full rooms', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('peerA', 'Host')!;
    manager.joinRoom(room.id, 'peerB', 'Joiner');
    expect(manager.joinRoom(room.id, 'peerC', 'Third')).toBe('full');
    expect(manager.joinRoom('XXXX-XXXX', 'peerC', 'Third')).toBe('not-found');
  });

  it('removes the room when the last peer leaves', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('peerA', 'Host')!;
    manager.joinRoom(room.id, 'peerB', 'Joiner');
    expect(manager.leaveRoom(room.id, 'peerA')!.remaining).toEqual(['peerB']);
    expect(manager.size).toBe(1);
    expect(manager.leaveRoom(room.id, 'peerB')!.remaining).toEqual([]);
    expect(manager.size).toBe(0);
    expect(manager.getRoom(room.id)).toBeUndefined();
  });

  it('leaving a room twice is harmless', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('peerA', 'Host')!;
    manager.leaveRoom(room.id, 'peerA');
    expect(manager.leaveRoom(room.id, 'peerA')).toBeNull();
  });

  it('refuses new rooms beyond the capacity limit', () => {
    const { manager } = makeManager({ maxRooms: 2 });
    expect(manager.createRoom('a', 'A')).not.toBeNull();
    expect(manager.createRoom('b', 'B')).not.toBeNull();
    expect(manager.createRoom('c', 'C')).toBeNull();
  });

  it('expires idle rooms on sweep and notifies', () => {
    const expired: string[] = [];
    const { manager, advance } = makeManager({ ttlMs: 10_000 });
    const room = manager.createRoom('peerA')!;
    manager.setRoomExpiredHandler((roomId) => expired.push(roomId));

    advance(9_000);
    expect(manager.sweepExpired()).toEqual([]);

    advance(2_000); // now 11s idle
    expect(manager.sweepExpired()).toEqual([room.id]);
    expect(manager.size).toBe(0);
    expect(expired).toEqual([room.id]);
  });

  it('activity extends the expiry', () => {
    const { manager, advance } = makeManager({ ttlMs: 10_000 });
    const room = manager.createRoom('peerA')!;
    advance(9_000);
    manager.touch(room); // resets the clock
    advance(9_000);
    expect(manager.sweepExpired()).toEqual([]);
    advance(2_000);
    expect(manager.sweepExpired()).toEqual([room.id]);
  });

  it('generates 12-character peer ids', () => {
    const { manager } = makeManager();
    const id = manager.generatePeerId();
    expect(id).toMatch(/^[A-Za-z0-9]{12}$/);
  });
});
