import type {
  IceServerConfig,
  PeerConnectionState,
  PeerInfo,
  RoomStatus,
  SignalingIncoming,
  TransferItem,
  ConversationEntry,
  OfferEntry,
  PasswordPromptEntry,
} from '../../types';
import { SignalingClient } from '../signaling/signalingClient';
import { PeerConnection } from '../webrtc/peerConnection';
import { TransferEngine, type IncomingOffer, type OutgoingEntry, type SendOptions } from '../transfer/fileTransfer';
import { serializeControl, PROTOCOL_VERSION } from '../transfer/protocol';
import { loadDeviceName, sanitizeDeviceName, saveDeviceName } from '../../utils/deviceName';
import { appendHistory } from '../history/transferHistory';

export interface RoomSnapshot {
  status: RoomStatus;
  roomId: string | null;
  selfPeerId: string | null;
  /** This device's display name; required before creating or joining a room. */
  deviceName: string | null;
  peers: PeerInfo[];
  transfers: TransferItem[];
  conversation: ConversationEntry[];
  offers: OfferEntry[];
  passwordPrompts: PasswordPromptEntry[];
  errorMessage: string | null;
  expiresAt: number | null;
  /** All device names in the room (for uniqueness checking) */
  deviceNamesInRoom: Record<string, string>;
  /** Error message for name conflict */
  nameConflictError: string | null;
  /** Live zip-preparation progress for an outgoing batch, when zipping. */
  zipProgress: { phase: 'zip' | 'done'; done: number; total: number } | null;
}

type Listener = (snapshot: RoomSnapshot) => void;

interface PeerBundle {
  connection: PeerConnection;
  engine: TransferEngine;
  state: PeerConnectionState;
  /** Device name announced by the peer over the data channel. */
  peerName: string | null;
  /** Parked batches waiting to be re-offered on a fresh link. */
  pendingBatches: { entries: OutgoingEntry[]; options: SendOptions }[];
}

const MAX_TRANSFERS_IN_STATE = 200;
const MAX_CONVERSATION_ENTRIES = 100;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
const MAX_RECONNECT_ATTEMPTS = 6;

function isTerminalStatus(status: TransferItem['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

const INITIAL_SNAPSHOT: RoomSnapshot = {
  status: 'idle',
  roomId: null,
  selfPeerId: null,
  deviceName: loadDeviceName(),
  peers: [],
  transfers: [],
  conversation: [],
  offers: [],
  passwordPrompts: [],
  errorMessage: null,
  expiresAt: null,
  deviceNamesInRoom: {},
  nameConflictError: null,
  zipProgress: null,
};

/**
 * Coordinates the signaling socket, one PeerConnection + TransferEngine per
 * room member, and exposes a single immutable snapshot to the UI.
 *
 * Offer/answer ordering is deterministic: the room creator (host) creates
 * the DataChannel and sends the offer when someone joins; joiners are polite
 * and answer. Signaling reconnects with capped exponential backoff; WebRTC
 * connections survive signaling blips, and in-flight file transfers park and
 * resume when the link returns.
 */
export class RoomSession {
  private signaling: SignalingClient | null = null;
  private readonly signalingUrl: string;
  private readonly iceServers: IceServerConfig[];
  private readonly peers = new Map<string, PeerBundle>();
  private readonly listeners = new Set<Listener>();
  private isHost = false;
  private disposed = false;
  private snapshot: RoomSnapshot = INITIAL_SNAPSHOT;
  private readonly initialMessage: { type: 'create-room' } | { type: 'join-room'; roomId: string } | null = null;
  private pendingInitial: { type: 'create-room' } | { type: 'join-room'; roomId: string } | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;
  private wakeLock: { release: () => Promise<void> } | null = null;

  constructor(signalingUrl: string, iceServers: IceServerConfig[]) {
    this.signalingUrl = signalingUrl;
    this.iceServers = iceServers;
    void this.initialMessage;
  }

  /** Replaces the ICE server list (takes effect for newly created peers). */
  updateIceServers(iceServers: IceServerConfig[]): void {
    this.iceServers.splice(0, this.iceServers.length, ...iceServers);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): RoomSnapshot {
    return this.snapshot;
  }

  createRoom(): void {
    if (!this.snapshot.deviceName) {
      this.setSnapshot({ errorMessage: 'Name this device before creating a room.' });
      return;
    }
    this.reset();
    this.isHost = true;
    this.pendingInitial = { type: 'create-room' };
    this.connectSignaling();
  }

  joinRoom(roomId: string): void {
    if (!this.snapshot.deviceName) {
      this.setSnapshot({ errorMessage: 'Name this device before joining a room.' });
      return;
    }
    this.reset();
    this.isHost = false;
    this.pendingInitial = { type: 'join-room', roomId };
    this.connectSignaling();
  }

  /** Clears a surfaced name conflict (e.g. when leaving the conflict screen). */
  clearNameConflict(): void {
    if (this.snapshot.nameConflictError !== null) {
      this.setSnapshot({ nameConflictError: null });
    }
  }

  /**
   * Sets (and persists) this device's display name. Connected peers are
   * re-notified over their data channels; the server never sees the name.
   */
  setDeviceName(rawName: string): boolean {
    const name = sanitizeDeviceName(rawName);
    if (!name) return false;
    saveDeviceName(name);
    this.setSnapshot({ deviceName: name });
    for (const bundle of this.connectedPeers()) {
      try {
        bundle.connection.sendText(serializeControl({ type: 'hello', protocol: PROTOCOL_VERSION, name }));
      } catch {
        /* channel racing to close */
      }
    }
    return true;
  }

  private connectSignaling(): void {
    this.setSnapshot({ status: 'connecting', errorMessage: null });
    const initial = this.pendingInitial;
    // The device name travels with create/join so the server can enforce
    // per-room uniqueness before this device is ever added to the room.
    const name = this.snapshot.deviceName ?? undefined;
    const withName = initial ? { ...initial, ...(name ? { deviceName: name } : {}) } : null;
    this.signaling = new SignalingClient(this.signalingUrl, {
      onMessage: (message) => this.handleSignalingMessage(message),
      onStateChange: (state) => {
        if (state === 'open') {
          this.reconnectAttempts = 0;
          if (withName) this.signaling?.send(withName);
          return;
        }
        if (state === 'closed') {
          this.scheduleReconnect();
        }
      },
    });
    this.signaling.connect();
  }

  /**
   * Reconnects the signaling socket with capped exponential backoff. Room
   * state survives on the server for the TTL window, so a short blip does
   * not have to destroy the session; WebRTC links are unaffected.
   */
  private scheduleReconnect(): void {
    if (this.disposed || this.intentionalClose) return;
    if (this.reconnectTimer !== null) return;
    if (this.snapshot.roomId === null) {
      // Never got into a room: surface the failure.
      if (this.snapshot.status === 'connecting') {
        this.failSession('Could not reach the Droply server. Check your network connection and try again.');
      }
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.failSession('Lost the connection to the Droply server. Start a new room to continue.');
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempts += 1;
    this.setSnapshot({ status: 'reconnecting', errorMessage: null });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.intentionalClose) return;
      this.connectSignaling();
    }, delay);
  }

  private handleSignalingMessage(message: SignalingIncoming): void {
    if (this.disposed) return;
    switch (message.type) {
      case 'room-created':
        this.setSnapshot({
          status: 'waiting',
          roomId: message.roomId,
          selfPeerId: message.peerId,
          expiresAt: message.expiresAt || null,
          deviceNamesInRoom: message.deviceNames ? { [message.peerId]: message.deviceNames[0] || 'Unknown Device' } : {},
  nameConflictError: null,
  zipProgress: null,
});
        return;

      case 'room-joined':
        this.setSnapshot({
          status: 'connecting-peers',
          roomId: message.roomId,
          selfPeerId: message.peerId,
          expiresAt: message.expiresAt || null,
          deviceNamesInRoom: message.deviceNames || {},
  nameConflictError: null,
  zipProgress: null,
});
        for (const peerId of message.peers) {
          // Existing members initiate; this joiner is polite. Queued
          // remotely-initiated signals (if any) are adopted lazily.
          void this.ensurePolitePeer(peerId);
        }
        this.updateAggregateStatus();
        return;

      case 'peer-joined': {
        // Remember the newcomer's server-verified device name so the device
        // list shows real names even before the data-channel hello arrives.
        if (message.deviceName) {
          this.setSnapshot({
            deviceNamesInRoom: { ...this.snapshot.deviceNamesInRoom, [message.peerId]: message.deviceName },
          });
        }
        // We were already in the room, so we initiate toward the newcomer.
        // If that peer somehow already created its connection toward us
        // (late peer-joined), the existing bundle wins and no second
        // connection is created.
        this.ensurePeer(message.peerId, false);
        return;
      }

      case 'peer-left':
        this.removePeer(message.peerId);
        return;

      case 'signal':
        void this.handleSignal(message.from, message.sdp, message.candidate ?? null);
        return;

      case 'room-expired':
        this.teardownPeers();
        this.setSnapshot({ status: 'expired', peers: [], errorMessage: null });
        return;

      case 'error':
        // Handle NAME_EXISTS error
        if (message.code === 'NAME_EXISTS') {
          this.signaling?.close();
          this.signaling = null;
          this.pendingInitial = null;
          this.setSnapshot({
            status: 'idle',
            errorMessage: null,
            nameConflictError: message.message,
          });
          return;
        }
        // Fatal errors (ROOM_NOT_FOUND, ROOM_FULL, ALREADY_IN_ROOM, …) end
        // the room flow. RATE_LIMITED is explicitly transient and recoverable:
        // it means one frame hit the server's flood guard, so the session
        // shows a toast and carries on instead of tearing down a healthy room.
        if (message.code === 'RATE_LIMITED') {
          this.setSnapshot({ errorMessage: message.message });
          return;
        }
        // Transient per-message errors must not kill it — but the server only
        // sends protocol-level errors that indicate a broken flow, so surface
        // them while staying in the room when connected.
        if (this.snapshot.status === 'ready' || this.snapshot.status === 'waiting' || this.snapshot.status === 'reconnecting') {
          this.setSnapshot({ errorMessage: message.message });
        } else {
          this.setSnapshot({ status: 'error', errorMessage: message.message });
        }
        return;
    }
  }

  private ensurePeer(peerId: string, polite: boolean): PeerBundle {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const bundle = {} as PeerBundle;
    bundle.state = 'new';
    bundle.peerName = null;
    bundle.pendingBatches = [];

    const connection = new PeerConnection(this.iceServers, {
      onStateChange: (state) => {
        bundle.state = state;
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          const parked = bundle.engine.drainQueue();
          if (parked.length > 0) bundle.pendingBatches.push(...parked);
          bundle.engine.abortInFlight('The connection dropped. Transfers resume automatically when the link returns.');
          this.releaseWakeLockIfIdle();
        }
        this.refreshPeers();
        this.updateAggregateStatus();
      },
      onData: (data) => bundle.engine.handleData(data),
      onSignalOffer: (sdp) => this.sendSignal(peerId, { sdp }),
      onSignalAnswer: (sdp) => this.sendSignal(peerId, { sdp }),
      onSignalCandidate: (candidate) => this.sendSignal(peerId, { candidate }),
      onDataChannelOpen: () => {
        try {
          bundle.connection.sendText(
            serializeControl({
              type: 'hello',
              protocol: PROTOCOL_VERSION,
              ...(this.snapshot.deviceName ? { name: this.snapshot.deviceName } : {}),
            }),
          );
        } catch {
          /* channel racing to close */
        }
        bundle.state = 'connected';
        this.refreshPeers();
        this.updateAggregateStatus();
        // Resume any transfers parked by a dropped link, then re-offer
        // batches that were still waiting in the queue.
        bundle.engine.resumeQueued();
        const parked = bundle.pendingBatches.splice(0, bundle.pendingBatches.length);
        for (const batch of parked) {
          bundle.engine.enqueue(batch.entries, batch.options);
        }
      },
    });

    const engine = new TransferEngine(connection, {
      onTransferUpdate: (item) => this.onTransferUpdate(peerId, item),
      onText: (entry) => this.onTextReceived(entry),
      onOfferReceived: (offer) => this.onOfferReceived(peerId, offer),
      onPasswordRequired: (batchId) => this.onPasswordRequired(peerId, batchId),
      onOfferSettled: (batchId) => this.setSnapshot({
        offers: this.snapshot.offers.filter((offer) => offer.batchId !== batchId),
      }),
      onOfferWithdrawn: (batchId) => this.setSnapshot({
        offers: this.snapshot.offers.filter((offer) => offer.batchId !== batchId),
        passwordPrompts: this.snapshot.passwordPrompts.filter((prompt) => prompt.batchId !== batchId),
      }),
      onPeerName: (name) => {
        bundle.peerName = name;
        this.refreshPeers();
      },
      onAuthFailed: (batchId) => this.onAuthFailed(peerId, batchId),
      onZipProgress: (progress) => {
        // 'done' clears the indicator; the pending items appear immediately
        // after with their own consent cards, so nothing else is needed.
        this.setSnapshot({ zipProgress: progress.phase === 'done' ? null : progress });
      },
    });

    bundle.connection = connection;
    bundle.engine = engine;
    this.peers.set(peerId, bundle);
    connection.init(polite);
    this.refreshPeers();
    this.updateAggregateStatus();
    return bundle;
  }

  /**
   * Creates the lazy receiver-side half of a connection for a peer we have
   * not heard a peer-joined for yet. Returns immediately when the peer is
   * already known (e.g. we initiated first), so offer races cannot duplicate
   * a connection.
   */
  private ensurePolitePeer(peerId: string): void {
    if (this.peers.has(peerId)) return;
    this.ensurePeer(peerId, true);
  }

  private async handleSignal(from: string, sdp?: string, candidate?: RTCIceCandidateInit | null): Promise<void> {
    // Adopt the connection lazily if the signal arrived before any
    // peer-joined for it. Whoever's offer exists determines the initiator:
    // offers received here are always answered (polite), answers complete
    // the offer we sent.
    const bundle = this.ensurePeer(from, true);
    try {
      if (sdp !== undefined) {
        // The host only ever receives answers; everyone else receives offers.
        if (this.isHost) {
          await bundle.connection.handleAnswer(sdp);
        } else {
          await bundle.connection.handleOffer(sdp);
        }
      }
      if (candidate) {
        await bundle.connection.handleCandidate(candidate);
      }
    } catch {
      bundle.state = 'failed';
      this.refreshPeers();
      this.updateAggregateStatus();
    }
  }

  private sendSignal(to: string, payload: { sdp?: string; candidate?: RTCIceCandidateInit | null }): void {
    this.signaling?.send({ type: 'signal', to, ...payload });
  }

  private removePeer(peerId: string): void {
    const bundle = this.peers.get(peerId);
    if (!bundle) return;
    bundle.engine.dispose();
    bundle.connection.close();
    this.peers.delete(peerId);
    this.clearOffersForPeer(peerId);
    this.refreshPeers();
    this.updateAggregateStatus();
  }

  private teardownPeers(): void {
    for (const peerId of [...this.peers.keys()]) {
      this.removePeer(peerId);
    }
  }

  private clearOffersForPeer(peerId: string): void {
    this.setSnapshot({
      offers: this.snapshot.offers.filter((offer) => offer.peerId !== peerId),
      passwordPrompts: this.snapshot.passwordPrompts.filter((prompt) => prompt.peerId !== peerId),
    });
  }

  private refreshPeers(): void {
    const peers: PeerInfo[] = [...this.peers.entries()].map(([peerId, bundle]) => ({
      peerId,
      state: bundle.state,
      name: bundle.peerName,
    }));
    this.setSnapshot({ peers });
  }

  private updateAggregateStatus(): void {
    const s = this.snapshot;
    if (s.status === 'error' || s.status === 'expired' || s.status === 'connecting' || s.status === 'reconnecting') return;
    const bundles = [...this.peers.values()];
    const anyConnected = bundles.some((p) => p.connection.isChannelOpen());
    const anyPending = bundles.some(
      (p) => p.state === 'new' || p.state === 'connecting' || p.state === 'reconnecting',
    );
    if (anyConnected) {
      if (s.status !== 'ready') this.setSnapshot({ status: 'ready' });
      return;
    }
    if (anyPending) {
      if (s.status !== 'connecting-peers') this.setSnapshot({ status: 'connecting-peers' });
      return;
    }
    if (s.roomId !== null && this.peers.size === 0 && s.status !== 'waiting') {
      this.setSnapshot({ status: 'waiting' });
    }
  }

  // ---- public actions ----------------------------------------------------

  /** Offers files (or a zipped bundle) to every connected peer for consent. */
  async sendFiles(files: File[], options?: Partial<SendOptions>): Promise<void> {
    const targets = this.connectedPeers();
    if (targets.length === 0) {
      this.setSnapshot({ errorMessage: 'No device is connected yet. Wait for a peer to join, then try again.' });
      return;
    }
    const entries: OutgoingEntry[] = files.map((file) => ({
      file,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined,
    }));
    const sendOptions: SendOptions = {
      zip: options?.zip ?? false,
      zipLevel: options?.zipLevel ?? 6,
      password: options?.password ?? null,
    };
    for (const bundle of targets) {
      void bundle.engine.enqueue(entries, sendOptions);
    }
    void this.acquireWakeLock();
  }

  /** Broadcasts a text message to every connected peer. */
  sendText(text: string): boolean {
    const targets = this.connectedPeers();
    if (targets.length === 0) return false;
    const entry: ConversationEntry = { id: '', direction: 'outgoing', text, receivedAt: Date.now() };
    for (const bundle of targets) {
      const { id } = bundle.engine.sendTextMessage(text);
      entry.id = id;
    }
    this.pushConversation(entry);
    return true;
  }

  /** Receiver UI: accept all items of an offer. */
  acceptOffer(batchId: string): void {
    for (const bundle of this.peers.values()) {
      if (bundle.engine.respondToOffer(batchId, { decision: 'accepted' })) return;
    }
    this.setSnapshot({ offers: this.snapshot.offers.filter((offer) => offer.batchId !== batchId) });
  }

  /** Receiver UI: accept only the selected item indices of an offer. */
  acceptOfferItems(batchId: string, selected: number[]): void {
    for (const bundle of this.peers.values()) {
      if (bundle.engine.respondToOffer(batchId, { decision: 'accepted', selected })) return;
    }
    this.setSnapshot({ offers: this.snapshot.offers.filter((offer) => offer.batchId !== batchId) });
  }

  /** Receiver UI: decline an offer. */
  declineOffer(batchId: string): void {
    for (const bundle of this.peers.values()) {
      if (bundle.engine.respondToOffer(batchId, { decision: 'declined' })) return;
    }
    this.setSnapshot({ offers: this.snapshot.offers.filter((offer) => offer.batchId !== batchId) });
  }

  /**
   * Receiver UI: submit the password for a secure batch. Returns false only
   * when the attempt could not even start (e.g. no usable crypto on this
   * origin); a wrong password re-opens the prompt with an error instead.
   */
  async submitOfferPassword(batchId: string, password: string): Promise<boolean> {
    // Close the prompt immediately for a responsive UI: a missing auth entry
    // (already-settled batch) still closes it, and a wrong password re-opens
    // it with an error via onAuthFailed so the user can retry.
    this.setSnapshot({
      passwordPrompts: this.snapshot.passwordPrompts.filter((prompt) => prompt.batchId !== batchId),
    });
    for (const bundle of this.peers.values()) {
      try {
        if (await bundle.engine.submitPassword(batchId, password)) return true;
      } catch {
        /* a torn-down engine must not block the other peers */
      }
    }
    return false;
  }

  /** Receiver UI: abandon the password prompt; the sender is notified. */
  cancelOfferPassword(batchId: string): void {
    for (const bundle of this.peers.values()) {
      if (bundle.engine.cancelPassword(batchId)) break;
    }
    this.setSnapshot({
      passwordPrompts: this.snapshot.passwordPrompts.filter((prompt) => prompt.batchId !== batchId),
    });
  }

  cancelTransfer(transferId: string): void {
    for (const bundle of this.peers.values()) {
      bundle.engine.cancelTransfer(transferId, true);
    }
    this.updateTransfer(transferId, (item) => ({ ...item, status: 'cancelled' }));
  }

  pauseTransfer(transferId: string): void {
    for (const bundle of this.peers.values()) {
      bundle.engine.pauseTransfer(transferId);
    }
  }

  resumeTransfer(transferId: string): void {
    for (const bundle of this.peers.values()) {
      bundle.engine.resumeTransfer(transferId);
    }
  }

  /** Revokes the object URL of a completed incoming transfer. */
  revokeDownloadUrl(transferId: string): void {
    const item = this.snapshot.transfers.find((t) => t.transferId === transferId);
    if (item?.downloadUrl) {
      URL.revokeObjectURL(item.downloadUrl);
      this.updateTransfer(transferId, (t) => ({ ...t, downloadUrl: null }));
    }
  }

  statsFor(transferId: string): { bytesPerSecond: number; etaSeconds: number | null } {
    const item = this.snapshot.transfers.find((t) => t.transferId === transferId);
    const bundle = item ? this.peers.get(item.peerId) : undefined;
    if (!item || !bundle) return { bytesPerSecond: 0, etaSeconds: null };
    return bundle.engine.statsFor(item.transferId, item.bytesTransferred, item.size);
  }

  /** Leaves the room and tears down all state. */
  leaveRoom(): void {
    this.reset();
    this.setSnapshot({ ...INITIAL_SNAPSHOT, deviceName: this.snapshot.deviceName });
  }

  dispose(): void {
    this.disposed = true;
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reset();
    this.listeners.clear();
    void this.releaseWakeLock();
  }

  // ---- offers & password prompts -------------------------------------------

  private onOfferReceived(peerId: string, offer: IncomingOffer): void {
    const entry: OfferEntry = {
      batchId: offer.batchId,
      peerId,
      senderName: this.peers.get(peerId)?.peerName ?? null,
      secure: offer.secure,
      items: offer.items.map((meta) => ({
        name: meta.name,
        relativePath: meta.relativePath,
        size: meta.size,
        mimeType: meta.mimeType,
      })),
    };
    this.setSnapshot({ offers: [...this.snapshot.offers, entry] });
    this.notifyOnOffer(entry.senderName);
  }

  private onPasswordRequired(peerId: string, batchId: string): void {
    const exists = this.snapshot.passwordPrompts.some((prompt) => prompt.batchId === batchId);
    if (exists) return;
    this.setSnapshot({
      passwordPrompts: [
        ...this.snapshot.passwordPrompts,
        { batchId, peerId, senderName: this.peers.get(peerId)?.peerName ?? null, error: null },
      ],
    });
  }

  /** The entered password did not match: re-open the prompt with an error. */
  private onAuthFailed(peerId: string, batchId: string): void {
    const senderName = this.peers.get(peerId)?.peerName ?? null;
    const prompts = this.snapshot.passwordPrompts;
    const existing = prompts.find((prompt) => prompt.batchId === batchId);
    if (existing) {
      this.setSnapshot({
        passwordPrompts: prompts.map((prompt) =>
          prompt.batchId === batchId
            ? { ...prompt, error: 'That password did not match. Check it with the sender and try again.' }
            : prompt,
        ),
      });
      return;
    }
    this.setSnapshot({
      passwordPrompts: [
        ...prompts,
        {
          batchId,
          peerId,
          senderName,
          error: 'That password did not match. Check it with the sender and try again.',
        },
      ],
    });
  }

  private notifyOnOffer(senderName: string | null): void {
    if (typeof Notification === 'undefined') return;
    try {
      if (Notification.permission === 'granted') {
        new Notification('Droply', { body: `${senderName ?? 'A device'} wants to send you files.` });
      }
    } catch {
      /* notifications unavailable */
    }
  }

  // ---- wake lock -------------------------------------------------------------

  private async acquireWakeLock(): Promise<void> {
    if (this.wakeLock) return;
    try {
      const { requestWakeLock } = await import('../wakeLock');
      const handle = await requestWakeLock();
      if (handle) this.wakeLock = handle;
    } catch {
      /* wake lock is best-effort */
    }
  }

  private releaseWakeLockIfIdle(): void {
    const anyActive = [...this.peers.values()].some((bundle) => bundle.engine.hasActiveWork());
    if (!anyActive) void this.releaseWakeLock();
  }

  private async releaseWakeLock(): Promise<void> {
    const handle = this.wakeLock;
    this.wakeLock = null;
    if (handle) await handle.release();
  }

  // ---- snapshot plumbing ---------------------------------------------------

  private connectedPeers(): PeerBundle[] {
    return [...this.peers.values()].filter((b) => b.connection.isChannelOpen());
  }

  private onTransferUpdate(peerId: string, item: TransferItem): void {
    const withPeer: TransferItem = { ...item, peerId, peerName: this.peers.get(peerId)?.peerName ?? item.peerName };
    const existing = this.snapshot.transfers.findIndex((t) => t.transferId === withPeer.transferId);
    const previous = existing >= 0 ? this.snapshot.transfers[existing] : undefined;
    let transfers: TransferItem[];
    if (existing >= 0) {
      transfers = this.snapshot.transfers.map((t, i) => (i === existing ? withPeer : t));
    } else {
      transfers = [...this.snapshot.transfers, withPeer];
      if (transfers.length > MAX_TRANSFERS_IN_STATE) {
        const removable = transfers.findIndex(
          (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
        );
        if (removable >= 0) {
          const dropped = transfers[removable];
          if (dropped?.downloadUrl) URL.revokeObjectURL(dropped.downloadUrl);
          transfers = transfers.filter((_, i) => i !== removable);
        }
      }
    }
    this.setSnapshot({ transfers });
    // Persist to the local history exactly once, when the transfer reaches a
    // terminal state (completed / failed / cancelled).
    if (isTerminalStatus(withPeer.status) && (!previous || !isTerminalStatus(previous.status))) {
      this.recordHistory(withPeer);
    }
  }

  private recordHistory(item: TransferItem): void {
    if (item.status !== 'completed' && item.status !== 'failed' && item.status !== 'cancelled') return;
    const selfName = this.snapshot.deviceName;
    appendHistory({
      id: `${item.transferId}:${item.direction}`,
      name: item.name,
      size: item.size,
      bytesTransferred: item.bytesTransferred,
      direction: item.direction === 'outgoing' ? 'sent' : 'received',
      status: item.status,
      senderName: item.direction === 'outgoing' ? selfName : item.peerName,
      receiverName: item.direction === 'outgoing' ? item.peerName : selfName,
      secure: item.secure,
      zipped: item.zipped,
      finishedAt: Date.now(),
    });
  }

  private updateTransfer(transferId: string, mutate: (item: TransferItem) => TransferItem): void {
    const transfers = this.snapshot.transfers.map((t) => (t.transferId === transferId ? mutate(t) : t));
    this.setSnapshot({ transfers });
  }

  private onTextReceived(entry: { id: string; text: string }): void {
    this.pushConversation({ id: entry.id, direction: 'incoming', text: entry.text, receivedAt: Date.now() });
  }

  private pushConversation(entry: ConversationEntry): void {
    let conversation = [...this.snapshot.conversation, entry];
    if (conversation.length > MAX_CONVERSATION_ENTRIES) {
      conversation = conversation.slice(conversation.length - MAX_CONVERSATION_ENTRIES);
    }
    this.setSnapshot({ conversation });
  }

  private setSnapshot(partial: Partial<RoomSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private failSession(message: string): void {
    this.teardownPeers();
    this.signaling?.close();
    this.signaling = null;
    this.setSnapshot({ status: 'error', errorMessage: message, peers: [] });
  }

  private reset(): void {
    // History completeness: anything still in flight (or queued) when the
    // room is left or reset never reaches a terminal status, so it would
    // otherwise vanish from the transfer history. Record it as cancelled
    // with the bytes that actually moved.
    for (const item of this.snapshot.transfers) {
      if (!isTerminalStatus(item.status)) this.recordHistory({ ...item, status: 'cancelled' });
    }
    this.teardownPeers();
    this.signaling?.close();
    this.signaling = null;
    this.pendingInitial = null;
    for (const item of this.snapshot.transfers) {
      if (item.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
    }
    // The device identity survives room changes; everything else resets.
    this.snapshot = { ...INITIAL_SNAPSHOT, deviceName: this.snapshot.deviceName };
  }
}
