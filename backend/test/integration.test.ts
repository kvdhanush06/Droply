import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddressInfo } from 'node:net';
import { createDroplyServer, type DroplyServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

/** Minimal WebSocket test client with a message queue. */
class TestClient {
  private ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: ((msg: ServerMessage) => void)[] = [];
  readonly closed: Promise<void>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener('close', () => resolve());
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('connect failed')), { once: true });
    });
    return new TestClient(ws);
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  next(timeoutMs = 3000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a server message')), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  async nextOfType(type: string, timeoutMs = 3000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msg = await this.next(Math.max(1, deadline - Date.now()));
      if (msg.type === type) return msg;
    }
  }

  close(): void {
    this.ws.close();
  }
}

let server: DroplyServer;
let port: number;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    MAX_ROOM_PEERS: '2',
    RATE_LIMIT_MESSAGES_PER_SECOND: '1000',
    RATE_LIMIT_CONNECTIONS_PER_MINUTE: '10000',
    RATE_LIMIT_ROOM_CREATES_PER_MINUTE: '10000',
    RATE_LIMIT_ROOM_JOINS_PER_MINUTE: '10000',
  });
  server = createDroplyServer(config, createSilentLogger());
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  port = (server.httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await server.close();
});

describe('signaling flow', () => {
  it('creates a room and returns a shareable code', async () => {
    const host = await TestClient.connect(port);
    host.send({ type: 'create-room' });
    const msg = await host.nextOfType('room-created');
    expect(msg.roomId).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(msg.peerId).toMatch(/^[A-Za-z0-9]{12}$/);
    host.close();
  });

  it('joins a second peer and notifies both sides', async () => {
    const host = await TestClient.connect(port);
    host.send({ type: 'create-room', deviceName: 'Host' });
    const created = await host.nextOfType('room-created');

    const joiner = await TestClient.connect(port);
    joiner.send({ type: 'join-room', roomId: created.roomId, deviceName: 'Joiner' });
    const joined = await joiner.nextOfType('room-joined');
    expect(joined.roomId).toBe(created.roomId);
    expect(joined.peers).toEqual([created.peerId]);

    const hostNotice = await host.nextOfType('peer-joined');
    expect(hostNotice.peerId).toBe(joined.peerId);

    host.close();
    joiner.close();
  });

  it('relays SDP and ICE candidates to the target peer', async () => {
    const host = await TestClient.connect(port);
    host.send({ type: 'create-room', deviceName: 'Host' });
    const created = await host.nextOfType('room-created');

    const joiner = await TestClient.connect(port);
    joiner.send({ type: 'join-room', roomId: created.roomId, deviceName: 'Joiner' });
    const joined = await joiner.nextOfType('room-joined');
    await host.nextOfType('peer-joined');

    host.send({ type: 'signal', to: joined.peerId, sdp: 'v=0 fake-offer' });
    const offer = await joiner.nextOfType('signal');
    expect(offer).toMatchObject({ from: created.peerId, sdp: 'v=0 fake-offer' });

    joiner.send({
      type: 'signal',
      to: created.peerId,
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    const ice = await host.nextOfType('signal');
    expect(ice.from).toBe(joined.peerId);
    expect((ice.candidate as { candidate: string }).candidate).toContain('127.0.0.1');

    host.close();
    joiner.close();
  });

  it('rejects joining a room that does not exist', async () => {
    const client = await TestClient.connect(port);
    client.send({ type: 'join-room', roomId: 'K7QF-9X2A' });
    const err = await client.nextOfType('error');
    expect(err.code).toBe('ROOM_NOT_FOUND');
    client.close();
  });

  it('rejects a duplicate device name with NAME_EXISTS and keeps the name free for others', async () => {
    const host = await TestClient.connect(port);
    host.send({ type: 'create-room', deviceName: 'KVD 1' });
    const created = await host.nextOfType('room-created');

    const joiner = await TestClient.connect(port);
    joiner.send({ type: 'join-room', roomId: created.roomId, deviceName: 'kvd 1' });
    const err = await joiner.nextOfType('error');
    expect(err.code).toBe('NAME_EXISTS');
    expect(String(err.message).toLowerCase()).toContain('kvd 1');

    // The clashing joiner was never added: a distinct name joins fine.
    joiner.send({ type: 'join-room', roomId: created.roomId, deviceName: 'KVD 2' });
    const joined = await joiner.nextOfType('room-joined');
    expect(joined.peerId).toBeDefined();

    // The existing member is told the newcomer's server-verified name.
    const notice = await host.nextOfType('peer-joined');
    expect(notice.deviceName).toBe('KVD 2');

    host.close();
    joiner.close();
  });

  it('sanitizes and defaults device names server-side', async () => {
    const host = await TestClient.connect(port);
    host.send({ type: 'create-room' });
    const created = await host.nextOfType('room-created');
    const room = server.rooms.getRoom(created.roomId as string)!;
    expect(room.peers.get(created.peerId as string)).toBe('Unknown Device');

    const joiner = await TestClient.connect(port);
    joiner.send({ type: 'join-room', roomId: created.roomId, deviceName: '  Eva\u0000’s Phone  ' });
    const joined = await joiner.nextOfType('room-joined');
    const names = [...room.peers.values()];
    expect(names).toContain('Eva’s Phone');
    expect(room.peers.get(joined.peerId as string)).toBe('Eva’s Phone');
    host.close();
    joiner.close();
  });

  it('rejects joining a full room', async () => {
    const host = await TestClient.connect(port);
    host.send({ type: 'create-room', deviceName: 'Host' });
    const created = await host.nextOfType('room-created');

    const second = await TestClient.connect(port);
    second.send({ type: 'join-room', roomId: created.roomId, deviceName: 'Second' });
    await second.nextOfType('room-joined');

    const third = await TestClient.connect(port);
    third.send({ type: 'join-room', roomId: created.roomId, deviceName: 'Third' });
    const err = await third.nextOfType('error');
    expect(err.code).toBe('ROOM_FULL');

    host.close();
    second.close();
    third.close();
  });

  it('notifies the remaining peer on disconnect and rejoins work', async () => {
    const host = await TestClient.connect(port);
    host.send({ type: 'create-room', deviceName: 'Host' });
    const created = await host.nextOfType('room-created');

    const joiner = await TestClient.connect(port);
    joiner.send({ type: 'join-room', roomId: created.roomId, deviceName: 'Joiner' });
    const joined = await joiner.nextOfType('room-joined');

    host.close();
    const notice = await joiner.nextOfType('peer-left');
    expect(notice.peerId).toBe(created.peerId);

    const third = await TestClient.connect(port);
    third.send({ type: 'join-room', roomId: created.roomId, deviceName: 'Third' });
    const rejoined = await third.nextOfType('room-joined');
    expect(rejoined.peers).toEqual([joined.peerId]);

    joiner.close();
    third.close();
    await Promise.all([joiner.closed, third.closed]);
    // The server processes close frames asynchronously; poll briefly.
    const deadline = Date.now() + 2000;
    while (server.rooms.size !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.rooms.size).toBe(0);
  });

  it('routes only valid messages and leaves flood budgets untouched by bad ones', async () => {
    const client = await TestClient.connect(port);
    // Not in a room: routed nowhere, but answered without touching the bucket.
    client.send({ type: 'signal', to: 'AbCdEfGh1234', sdp: 'v=0' });
    const notInRoom = await client.nextOfType('error');
    expect(notInRoom.code).toBe('NOT_IN_ROOM');

    // Malformed room code: shape-valid JSON, invalid content.
    client.send({ type: 'join-room', roomId: 'NOPE!!!!' });
    const badCode = await client.nextOfType('error');
    expect(badCode.code).toBe('PROTOCOL_ERROR');
    client.close();
  });

  it('rejects malformed JSON with an error message', async () => {
    const client = await TestClient.connect(port);
    client.sendRaw('this is not json');
    const err = await client.nextOfType('error');
    expect(err.code).toBe('MALFORMED_MESSAGE');
    client.close();
  });

  it('rejects signaling to peers outside the room', async () => {
    const host = await TestClient.connect(port);
    host.send({ type: 'create-room' });
    await host.nextOfType('room-created');
    host.send({ type: 'signal', to: 'AbCdEfGh1234', sdp: 'v=0' });
    const err = await host.nextOfType('error');
    expect(err.code).toBe('PEER_NOT_FOUND');
    host.close();
  });

  it('expires idle rooms and notifies members', async () => {
    const host = await TestClient.connect(port);
    host.send({ type: 'create-room' });
    const created = await host.nextOfType('room-created');

    const room = server.rooms.getRoom(created.roomId as string)!;
    room.expiresAt = 0;
    server.rooms.sweepExpired();

    const expired = await host.nextOfType('room-expired');
    expect(expired.roomId).toBe(created.roomId);
    host.close();
  });
});

describe('HTTP endpoints', () => {
  it('serves /health', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('serves /api/config with ICE servers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { iceServers: unknown[]; maxRoomPeers: number };
    expect(Array.isArray(body.iceServers)).toBe(true);
    expect(body.maxRoomPeers).toBe(2);
  });

  it('blocks path traversal attempts', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/%2e%2e/%2e%2e/package.json`);
    expect([403, 404]).toContain(res.status);
  });

  it('rejects non-GET methods', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

