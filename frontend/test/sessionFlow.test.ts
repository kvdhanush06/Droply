import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSession, type RoomSnapshot } from '../src/services/room/roomSession';
import { loadHistory } from '../src/services/history/transferHistory';
import type { IceServerConfig } from '../src/types';

/**
 * Full-stack two-session integration test: two real RoomSession instances
 * (host + joiner) wired through a fake in-memory signaling server and paired
 * fake RTCPeerConnections with real paired data channels. Everything above
 * the wire is production code: signaling client, session wiring, transfer
 * engines, the crypto facade and snapshot plumbing.
 *
 * `crypto.subtle` is stubbed away, forcing the pure-JS fallback exactly like
 * a plain-HTTP LAN origin (insecure context) would use.
 */

const realCrypto = globalThis.crypto;

/** Removes WebCrypto, forcing the jsCrypto fallback (insecure-context parity). */
function forceInsecureCrypto(): void {
  vi.stubGlobal('crypto', {
    getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
  });
  // jsdom has no object-URL factory; completed incoming items still need a
  // download link like a real browser produces.
  let objectUrlCounter = 0;
  vi.stubGlobal('URL', {
    createObjectURL: () => `blob:fake-${(objectUrlCounter += 1)}`,
    revokeObjectURL: () => undefined,
  });
}

forceInsecureCrypto();

// ---- fake signaling server -------------------------------------------------

interface FakeSocket {
  send: (data: string) => void;
  onmessage: ((event: { data: string }) => void) | null;
}

const roomState = {
  id: '',
  members: new Map<string, { socket: FakeSocket; name: string }>(),
};

function fakeServerDeliver(socket: FakeSocket, raw: string): void {
  const msg = JSON.parse(raw) as Record<string, unknown>;
  const reply = (payload: unknown): void => {
    queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(payload) }));
  };
  if (msg.type === 'create-room') {
    roomState.id = 'ABCD-2345';
    roomState.members.clear();
    const peerId = 'hostPeerId01';
    roomState.members.set(peerId, { socket, name: String(msg.deviceName ?? 'Unknown Device') });
    reply({
      type: 'room-created',
      roomId: roomState.id,
      peerId,
      expiresAt: Date.now() + 600_000,
      deviceNames: [msg.deviceName ?? 'Unknown Device'],
    });
    return;
  }
  if (msg.type === 'join-room') {
    if (msg.roomId !== roomState.id) {
      reply({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'No room with that code exists. It may have expired.' });
      return;
    }
    // Same case-insensitive name uniqueness rule as the real server.
    const wanted = String(msg.deviceName ?? 'Unknown Device').trim().toLowerCase();
    for (const member of roomState.members.values()) {
      if (member.name.trim().toLowerCase() === wanted) {
        reply({
          type: 'error',
          code: 'NAME_EXISTS',
          message: `The name “${String(msg.deviceName)}” is already used by another device in this room. Choose a different name.`,
        });
        return;
      }
    }
    const peerId = 'joinPeerId02';
    const hostEntry = [...roomState.members.entries()][0]!;
    roomState.members.set(peerId, { socket, name: String(msg.deviceName ?? 'Unknown Device') });
    reply({
      type: 'room-joined',
      roomId: roomState.id,
      peerId,
      peers: [hostEntry[0]],
      deviceNames: { [hostEntry[0]]: hostEntry[1].name },
      expiresAt: Date.now() + 600_000,
    });
    queueMicrotask(() =>
      hostEntry[1].socket.onmessage?.({
        data: JSON.stringify({ type: 'peer-joined', peerId, deviceName: msg.deviceName ?? 'Unknown Device' }),
      }),
    );
    return;
  }
  if (msg.type === 'signal') {
    const target = roomState.members.get(String(msg.to));
    const from = [...roomState.members.entries()].find(([, m]) => m.socket === socket)?.[0];
    if (target && from) {
      const outbound: Record<string, unknown> = { type: 'signal', from };
      if (msg.sdp !== undefined) outbound.sdp = msg.sdp;
      if (msg.candidate !== undefined) outbound.candidate = msg.candidate;
      queueMicrotask(() => target.socket.onmessage?.({ data: JSON.stringify(outbound) }));
    }
  }
}

// ---- fake RTCPeerConnection with paired data channels ----------------------

class FakeDataChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  peer: FakeDataChannel | null = null;

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open' || !this.peer) return;
    const target = this.peer;
    queueMicrotask(() => target.onmessage?.({ data }));
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  close(): void {
    this.readyState = 'closed';
  }
}

const pcQueue: FakeRTCPeerConnection[] = [];

class FakeRTCPeerConnection {
  remote: FakeRTCPeerConnection | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(_config?: unknown) {
    pcQueue.push(this);
    // Pair the two most recent unpaired instances (host + joiner per test).
    const unpaired = pcQueue.filter((pc) => pc.remote === null);
    if (unpaired.length >= 2) {
      const [a, b] = unpaired as [FakeRTCPeerConnection, FakeRTCPeerConnection];
      a.remote = b;
      b.remote = a;
    }
  }

  createDataChannel(_label: string, _opts?: unknown): RTCDataChannel {
    const channel = new FakeDataChannel();
    const remoteChannel = new FakeDataChannel();
    channel.peer = remoteChannel;
    remoteChannel.peer = channel;
    // Deliver the remote half, then open both once handlers are attached.
    queueMicrotask(() => {
      this.remote?.ondatachannel?.({ channel: remoteChannel as unknown as RTCDataChannel });
      setTimeout(() => {
        remoteChannel.open();
        channel.open();
      }, 5);
    });
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCLocalSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0 fake offer' };
  }
  async createAnswer(): Promise<RTCLocalSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0 fake answer' };
  }
  async setLocalDescription(_desc?: unknown): Promise<void> {}
  async setRemoteDescription(_desc: unknown): Promise<void> {}
  async addIceCandidate(_candidate: unknown): Promise<void> {}
  get connectionState(): RTCPeerConnectionState {
    return 'connected';
  }
  get localDescription(): RTCSessionDescriptionInit {
    return { type: 'offer', sdp: 'v=0 fake offer' };
  }
  get remoteDescription(): RTCSessionDescriptionInit {
    return { type: 'offer', sdp: 'v=0 fake offer' };
  }
  close(): void {}
}

class FakeWebSocket {
  // The real WebSocket constants: SignalingClient.isOpen() compares
  // readyState against WebSocket.OPEN, so the fake must provide them.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    fakeServerDeliver(this as unknown as FakeSocket, data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

// ---- helpers ----------------------------------------------------------------

const ICE: IceServerConfig[] = [{ urls: ['stun:stun.l.google.com:19302'] }];

function makeFile(name: string, bytes: number): File {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) data[i] = i & 0xff;
  return new File([data], name, { type: 'text/plain' });
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---- the tests ----------------------------------------------------------------

describe('two real sessions over the full stack (insecure-context crypto)', () => {
  let host: RoomSession;
  let joiner: RoomSession;
  let hostSnap: () => RoomSnapshot;
  let joinerSnap: () => RoomSnapshot;

  const boot = (): void => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection as unknown as typeof RTCPeerConnection);
    localStorage.clear();
    host = new RoomSession('ws://fake', ICE);
    joiner = new RoomSession('ws://fake', ICE);
    hostSnap = () => host.getSnapshot();
    joinerSnap = () => joiner.getSnapshot();
  };

  afterEach(() => {
    host?.dispose();
    joiner?.dispose();
    pcQueue.length = 0;
    roomState.members.clear();
    roomState.id = '';
    vi.unstubAllGlobals();
    forceInsecureCrypto();
  });

  it('completes a password-protected transfer end to end: receiver gets the file, sender is not stuck', async () => {
    boot();
    host.setDeviceName('KVD 1');
    joiner.setDeviceName('KVD 2');
    host.createRoom();
    await waitFor(() => hostSnap().status === 'waiting');

    joiner.joinRoom(roomState.id);
    await waitFor(() => hostSnap().status === 'ready' && joinerSnap().status === 'ready');

    // Host sends one password-protected file.
    void host.sendFiles([makeFile('secret.txt', 600)], { zip: false, zipLevel: 0, password: 'pw-123' });
    await waitFor(() => joinerSnap().offers.length === 1);
    joiner.acceptOffer(joinerSnap().offers[0]!.batchId);

    // The password prompt appears; the receiver enters the CORRECT password.
    await waitFor(() => joinerSnap().passwordPrompts.length === 1);
    const batchId = joinerSnap().passwordPrompts[0]!.batchId;
    const ok = await joiner.submitOfferPassword(batchId, 'pw-123');
    expect(ok).toBe(true);

    // The receiver must end up with a completed, downloadable file.
    await waitFor(() => joinerSnap().transfers.some((t) => t.direction === 'incoming' && t.status === 'completed'));
    const incoming = joinerSnap().transfers.find((t) => t.direction === 'incoming')!;
    expect(incoming.name).toBe('secret.txt');
    expect(incoming.bytesTransferred).toBe(600);
    expect(incoming.downloadUrl).toContain('blob:');

    // The sender must NOT be stuck waiting: its item completed too.
    const outgoing = hostSnap().transfers.find((t) => t.direction === 'outgoing')!;
    expect(outgoing.status).toBe('completed');

    // Both devices recorded the finished transfer in their local history.
    await waitFor(() => loadHistory().some((entry) => entry.name === 'secret.txt' && entry.direction === 'received'));
    expect(loadHistory().some((entry) => entry.name === 'secret.txt' && entry.direction === 'sent')).toBe(true);
  }, 45_000);

  it('delivers every file of a multi-file password-protected batch', async () => {
    boot();
    host.setDeviceName('KVD 1');
    joiner.setDeviceName('KVD 2');
    host.createRoom();
    await waitFor(() => hostSnap().status === 'waiting');
    joiner.joinRoom(roomState.id);
    await waitFor(() => hostSnap().status === 'ready' && joinerSnap().status === 'ready');

    const files = [makeFile('s1.txt', 400), makeFile('s2.txt', 500), makeFile('s3.txt', 600)];
    void host.sendFiles(files, { zip: false, zipLevel: 0, password: 'pw-9' });
    await waitFor(() => joinerSnap().offers.length === 1);
    joiner.acceptOffer(joinerSnap().offers[0]!.batchId);

    await waitFor(() => joinerSnap().passwordPrompts.length === 1);
    const batchId = joinerSnap().passwordPrompts[0]!.batchId;
    expect(await joiner.submitOfferPassword(batchId, 'pw-9')).toBe(true);

    await waitFor(
      () =>
        joinerSnap().transfers.filter((t) => t.direction === 'incoming' && t.status === 'completed').length ===
        files.length,
      30_000,
    );
    // Every file decrypted and completed on the receiver…
    for (const name of files.map((f) => f.name)) {
      const incoming = joinerSnap().transfers.find((t) => t.name === name);
      expect(incoming?.status).toBe('completed');
      expect(incoming?.secure).toBe(true);
    }
    // …and the sender shows all three completed, none stuck waiting.
    expect(hostSnap().transfers.filter((t) => t.direction === 'outgoing' && t.status === 'completed')).toHaveLength(
      files.length,
    );
    expect(hostSnap().transfers.filter((t) => t.direction === 'outgoing' && t.status === 'queued')).toHaveLength(0);
  }, 60_000);

  it('shows the name conflict at join time and never lands in a phantom room', async () => {
    boot();
    host.setDeviceName('KVD 1');
    joiner.setDeviceName('KVD 1'); // same as the host on purpose
    host.createRoom();
    await waitFor(() => hostSnap().status === 'waiting');

    joiner.joinRoom(roomState.id);
    await waitFor(() => joinerSnap().nameConflictError !== null);
    expect(joinerSnap().nameConflictError).toMatch(/already used/i);
    // The joiner was never added to the room: no id, still idle.
    expect(joinerSnap().status).toBe('idle');
    expect(joinerSnap().roomId).toBeNull();

    // Renaming and rejoining succeeds without leaving the page flow.
    joiner.setDeviceName('KVD 2');
    joiner.joinRoom(roomState.id);
    await waitFor(() => joinerSnap().status === 'ready');
    expect(joinerSnap().nameConflictError).toBeNull();
  }, 45_000);

  it('keeps every file of a multi-file batch visible on the sender and receiver', async () => {
    boot();
    host.setDeviceName('KVD 1');
    joiner.setDeviceName('KVD 2');
    host.createRoom();
    await waitFor(() => hostSnap().status === 'waiting');
    joiner.joinRoom(roomState.id);
    await waitFor(() => hostSnap().status === 'ready' && joinerSnap().status === 'ready');

    const files = [
      makeFile('a.txt', 300),
      makeFile('b.txt', 400),
      makeFile('c.txt', 500),
      makeFile('d.txt', 600),
      makeFile('e.txt', 700),
    ];
    void host.sendFiles(files, { zip: false, zipLevel: 0, password: null });

    await waitFor(() => joinerSnap().offers.length === 1);
    joiner.acceptOffer(joinerSnap().offers[0]!.batchId);

    await waitFor(
      () => hostSnap().transfers.filter((t) => t.direction === 'outgoing' && t.status === 'completed').length === files.length,
      30_000,
    );
    expect(hostSnap().transfers.filter((t) => t.direction === 'outgoing')).toHaveLength(files.length);
    expect(joinerSnap().transfers.filter((t) => t.direction === 'incoming' && t.status === 'completed')).toHaveLength(
      files.length,
    );
    expect(loadHistory().filter((entry) => entry.direction === 'received')).toHaveLength(files.length);
  }, 60_000);
});
