import type { TransferItem, TransferStatus } from '../../types';
import type { PeerConnection } from '../webrtc/peerConnection';
import {
  CHUNK_SIZE,
  MAX_OFFER_BYTES,
  MAX_QUEUE_FILES,
  MAX_TRANSFERS_PER_SESSION,
  computeTotalChunks,
  generateTransferId,
  parseControlMessage,
  sanitizeFileName,
  sanitizeRelativePath,
  serializeControl,
  offerByteSize,
  type ControlMessage,
  type FileMeta,
  type OfferDecision,
} from './protocol';
import { createChunkSource, type ChunkSource } from './chunkSource';
import { zipInWorker } from './heavyTasks';
import { sanitizeDeviceName } from '../../utils/deviceName';
import {
  computeAuthProof,
  createAuthChallenge,
  decryptChunk,
  deriveSenderKey,
  encryptChunk,
  verifyAuthProof,
  type AesKey,
} from './crypto';

const BUFFER_HIGH_WATER = 4 * 1024 * 1024;
const BUFFER_LOW_WATER = 1024 * 1024;
const PROGRESS_EMIT_INTERVAL_MS = 150;
const MAX_ITEMS_PER_PEER = 64;
const ACK_TIMEOUT_MS = 30_000;
/** Grace wait for the receiver's consent decision. */
export const OFFER_TIMEOUT_MS = 10 * 60 * 1000;
/** Grace wait for the password handshake. */
export const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
/** Pause auto-expiry: paused transfers fail if the link never returns. */
export const RESUME_TIMEOUT_MS = 5 * 60 * 1000;
/** Upper bound for the tombstone set so teardown bookkeeping can never grow unbounded. */
const MAX_BATCH_TOMBSTONES = 512;

export interface TransferEngineEvents {
  onTransferUpdate: (item: TransferItem) => void;
  onText: (entry: { id: string; text: string }) => void;
  onOfferReceived: (offer: IncomingOffer) => void;
  onPasswordRequired: (batchId: string) => void;
  /** The receiver (or a timeout) settled a pending offer. */
  onOfferSettled: (batchId: string) => void;
  /** The sender withdrew a pending offer before the receiver answered. */
  onOfferWithdrawn?: (batchId: string) => void;
  /** The peer announced (or changed) its device name via the hello frame. */
  onPeerName?: (name: string | null) => void;
  /** Receiver side: the password the user entered did not match; it may retry. */
  onAuthFailed?: (batchId: string) => void;
  /** Receiver side: the user declined the password prompt; sender should fail the batch. */
  onAuthDeclined?: (batchId: string) => void;
  /** Sender side: live zip-preparation progress for the batch being built. */
  onZipProgress?: (progress: { phase: 'zip' | 'done'; done: number; total: number }) => void;
}

/** One item the sender intends to transfer. */
export interface OutgoingEntry {
  file: File;
  /** Folder path relative to the dropped root, when the item came from a folder. */
  relativePath?: string;
}

export interface SendOptions {
  /** Zip every file in the batch into a single bundle.zip archive. */
  zip: boolean;
  /** 0 = store (fast), 6 = deflate (smaller). */
  zipLevel: 0 | 6;
  /** When set, the batch is password-protected end to end. */
  password: string | null;
}

export interface IncomingOffer {
  batchId: string;
  secure: boolean;
  items: FileMeta[];
}

/** The receiver's answer to one offer. */
export interface OfferResponse {
  decision: OfferDecision;
  /** Indices of accepted items when accepting a subset. */
  selected?: number[];
  /** True when the sender itself withdrew the offer (not a remote decline). */
  localCancel?: boolean;
}

interface OutgoingState {
  item: TransferItem;
  file: File;
  meta: FileMeta;
  transferId: string;
  batchId: string;
  offset: number;
  cancelled: boolean;
  paused: boolean;
  /** True while a runSendLoop instance owns this transfer (pause-safe). */
  loopActive: boolean;
  acked: boolean;
  notifyAck: (() => void) | null;
  key: AesKey | null;
  resumeTimer: number | null;
}

interface IncomingState {
  item: TransferItem;
  meta: FileMeta;
  parts: BlobPart[];
  chunksReceived: number;
  key: AesKey | null;
  paused: boolean;
  resumeTimer: number | null;
}

interface PendingOffer {
  offer: IncomingOffer;
  resolve: (response: OfferResponse & { password?: string }) => void;
  timer: number;
}

interface PendingAuth {
  timer: number;
  expectedProof: Uint8Array | null;
  key: AesKey | null;
  challengeSent: boolean;
  challengeWaiter: ((challenge: { salt: Uint8Array; iterations: number } | null) => void) | null;
  resultWaiter: ((ok: boolean) => void) | null;
  /** Set when the receiver abandoned the prompt; wakes the sender's wait. */
  cancelled: boolean;
}

class RollingMeter {
  /**
   * Samples closer together than this are ignored: renders can fire back to
   * back (e.g. StrictMode double render), and dividing a large byte delta by
   * a near-zero interval produces absurd speeds like "287 GB/s".
   */
  private static readonly MIN_SAMPLE_DT_S = 0.1;
  private lastTime = 0;
  private lastBytes = 0;
  private ema = 0;

  sample(now: number, totalBytes: number): number {
    if (this.lastTime === 0) {
      this.lastTime = now;
      this.lastBytes = totalBytes;
      return 0;
    }
    const dt = (now - this.lastTime) / 1000;
    if (dt < RollingMeter.MIN_SAMPLE_DT_S) return this.ema;
    const delta = totalBytes - this.lastBytes;
    this.lastTime = now;
    this.lastBytes = totalBytes;
    if (delta <= 0) {
      // Stalled (or resumed from a retained offset): decay towards zero
      // instead of reporting a phantom spike.
      this.ema = delta === 0 ? this.ema * 0.7 : this.ema;
      return this.ema;
    }
    const instant = delta / dt;
    this.ema = this.ema === 0 ? instant : this.ema * 0.7 + instant * 0.3;
    return this.ema;
  }
}

/**
 * Drives the application-level transfer protocol over one peer's data
 * channel: batch consent offers, password handshake, metadata, chunked
 * binary streaming with backpressure and workers, ACKs, cancellation,
 * pause/resume and text messages.
 */
export class TransferEngine {
  private readonly peer: PeerConnection;
  /** Event sinks (wired once at construction; tests may re-wire individual handlers). */
  readonly events: TransferEngineEvents;
  private readonly outgoing = new Map<string, OutgoingState>();
  private readonly incoming = new Map<string, IncomingState>();
  private readonly offers = new Map<string, PendingOffer>();
  private readonly auths = new Map<string, PendingAuth>();
  private readonly emitTimes = new Map<string, number>();
  private readonly queue: { entries: OutgoingEntry[]; options: SendOptions }[] = [];
  private activeIncomingId: string | null = null;
  private transferCount = 0;
  /** One speed meter per transfer; sharing a single meter across transfers corrupts every reading. */
  private readonly meters = new Map<string, RollingMeter>();
  /** transferId -> batchId for items still awaiting the receiver's consent. */
  private readonly consentBatches = new Map<string, string>();
  /** batchId -> secure flag, remembered from the offer until file-start. */
  private readonly batchSecure = new Map<string, boolean>();
  /** Auth challenges that arrived before the sender armed its waiter (retries). */
  private readonly earlyChallenges = new Map<string, { salt: Uint8Array; iterations: number }>();
  /** Auth results that arrived before the sender armed its waiter. */
  private readonly earlyResults = new Map<string, boolean>();
  /**
   * Batch IDs that were torn down locally (user cancel, password abandon,
   * sender withdrawal). Tombstones make teardown final: a late password
   * submission must never resurrect a dead batch. Bounded by MAX_BATCH_TOMBSTONES.
   */
  private readonly batchTombstones = new Set<string>();
  private disposed = false;
  private readonly chunkSource: ChunkSource;
  private batchCounter = 0;
  private resuming = false;
  private frameChain: Promise<void> = Promise.resolve();

  constructor(peer: PeerConnection, events: TransferEngineEvents, chunkSource?: ChunkSource) {
    this.peer = peer;
    this.events = events;
    this.chunkSource = chunkSource ?? createChunkSource(2);
  }

  // ---- sender queue -------------------------------------------------------

  /**
   * Queues a batch for sending; the consent offer goes out immediately.
   *
   * Multiple batches may wait for the receiver's consent at the same time —
   * the receiver accepts them one by one. Only the actual byte streaming is
   * serialized per peer, so a second file goes to "waiting" right away and
   * starts streaming as soon as the first one finishes.
   */
  enqueue(entries: OutgoingEntry[], options: SendOptions): boolean {
    if (this.disposed || entries.length === 0) return false;
    if (this.queue.length >= MAX_QUEUE_FILES) return false;
    this.queue.push({ entries, options });
    void this.dispatchQueue();
    return true;
  }

  private makeBatchId(): string {
    this.batchCounter += 1;
    return `b${Date.now().toString(36)}${this.batchCounter}${generateTransferId()}`;
  }

  private dispatching = false;

  /**
   * Serializes actual byte streaming on one data channel: offers and password
   * handshakes run concurrently per batch, but chunks of two files must never
   * interleave. Callers enter the gate before streaming and release it when
   * their last item settles.
   */
  private streamGate: Promise<void> = Promise.resolve();

  private async dispatchQueue(): Promise<void> {
    // Batches leave the queue immediately so every chosen file shows its
    // consent offer right away. Inside sendBatch the offer/auth phases run
    // concurrently per batch; only the byte streaming itself is serialized
    // per peer via the stream gate above.
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queue.length > 0 && !this.disposed && !this.resuming) {
        if (!this.peer.isChannelOpen()) return;
        const batch = this.queue.shift()!;
        void this.sendBatch(batch.entries, batch.options);
      }
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * Builds the final File list for a batch, zipping when requested. The zip
   * runs in a worker with per-file progress so the UI stays responsive and
   * shows live feedback while the archive is prepared.
   */
  private async materialize(entries: OutgoingEntry[], options: SendOptions): Promise<OutgoingEntry[]> {
    if (!options.zip) return entries;
    const treeNames = entries.map((entry) =>
      entry.relativePath
        ? `${sanitizeRelativePath(entry.relativePath)}/${sanitizeFileName(entry.file.name)}`
        : sanitizeFileName(entry.file.name),
    );
    this.events.onZipProgress?.({ phase: 'zip', done: 0, total: entries.length });
    const blob = await zipInWorker(
      entries.map((entry) => entry.file),
      treeNames,
      options.zipLevel,
      (done, total) => this.events.onZipProgress?.({ phase: 'zip', done, total }),
    );
    const bundled = [{ file: new File([blob], 'bundle.zip', { type: 'application/zip' }) }];
    this.events.onZipProgress?.({ phase: 'done', done: 1, total: 1 });
    return bundled;
  }

  /** Runs one queued batch through consent + (optional) password + streaming. */
  private async sendBatch(entries: OutgoingEntry[], options: SendOptions): Promise<void> {
    if (this.transferCount >= MAX_TRANSFERS_PER_SESSION) return;
    if (!this.peer.isChannelOpen()) return;

    let items: OutgoingEntry[];
    try {
      items = await this.materialize(entries, options);
    } catch (err) {
      const item = this.makeItem(generateTransferId(), 'bundle.zip', 0, 'outgoing');
      item.status = 'failed';
      item.error = err instanceof Error ? err.message : 'Could not create the zip archive.';
      this.emit(item, true);
      return;
    }

    const batchId = this.makeBatchId();
    const metas: FileMeta[] = items.map((entry) => ({
      name: sanitizeFileName(entry.file.name || 'droply-file'),
      relativePath: entry.relativePath ? sanitizeRelativePath(entry.relativePath) : undefined,
      size: entry.file.size,
      mimeType: entry.file.type || 'application/octet-stream',
      chunkSize: CHUNK_SIZE,
      totalChunks: computeTotalChunks(entry.file.size, CHUNK_SIZE),
    }));

    // 1. Consent: nothing flows until the receiver accepts.
    const offer = { type: 'offer' as const, batchId, secure: options.password !== null, items: metas };
    if (offerByteSize(offer) > MAX_OFFER_BYTES) {
      this.failBatchLocally(metas, 'The file list is too large for one batch. Send fewer files at once.');
      return;
    }
    // Sender-side feedback: every offered item shows as pending consent.
    const transferIds = metas.map(() => generateTransferId());
    const pendingItems = metas.map((meta, index) => {
      const item = this.makeItem(transferIds[index]!, meta.name, meta.size, 'outgoing');
      if (meta.relativePath) item.name = meta.relativePath;
      item.status = 'queued';
      item.paused = false;
      item.secure = options.password !== null;
      item.zipped = options.zip;
      item.error = 'Waiting for the receiving device to accept…';
      this.consentBatches.set(item.transferId, batchId);
      this.emit(item, true);
      return item;
    });

    const response = await this.requestOfferDecision(batchId, offer);
    for (const id of transferIds) this.consentBatches.delete(id);
    if (response.decision !== 'accepted') {
      for (const item of pendingItems) {
        item.status = 'cancelled';
        item.error = response.localCancel ? 'Cancelled.' : 'Declined by the receiving device.';
        this.emit(item, true);
      }
      return;
    }

    const selected = new Set(response.selected ?? metas.map((_, index) => index));
    const accepted = metas
      .map((meta, index) => ({ entry: items[index]!, meta, transferId: transferIds[index]!, item: pendingItems[index]! }))
      .filter((_, index) => selected.has(index) && index >= 0 && index < metas.length);
    for (const [index, item] of pendingItems.entries()) {
      if (!selected.has(index)) {
        item.status = 'cancelled';
        item.error = 'Not selected by the receiving device.';
        this.emit(item, true);
      }
    }
    if (accepted.length === 0) return;

    // Secure batches: the consent card must not keep saying "waiting for the
    // receiving device to accept" while the password handshake runs.
    if (options.password !== null) {
      for (const pending of accepted.map((entry) => entry.item)) {
        pending.error = 'Checking the password with the receiving device…';
        this.emit(pending, true);
      }
    }

    // 2. Password handshake for secure batches. The receiver may retry a
    // wrong password a few times; each retry is a fresh challenge round.
    let key: AesKey | null = null;
    if (options.password !== null) {
      const MAX_AUTH_ATTEMPTS = 3;
      for (let attempt = 1; ; attempt += 1) {
        const challenge = await this.waitForAuthChallenge(batchId);
        if (!challenge) {
          // The receiver never completed (or abandoned) the password entry,
          // or the sender cancelled while waiting: settle the items so the
          // sender UI does not sit at "waiting" forever.
          const locallyCancelled = this.batchTombstones.has(batchId);
          for (const pending of pendingItems) {
            pending.status = locallyCancelled ? 'cancelled' : 'failed';
            pending.error = locallyCancelled
              ? 'Cancelled.'
              : 'The password step was not completed on the receiving device.';
            this.emit(pending, true);
          }
          return;
        }
        // Arm the result waiter BEFORE sending the verify frame: frame
        // delivery can be synchronous (fast local loops), and the result must
        // never arrive before its waiter exists.
        const resultPromise = this.waitForAuthResult(batchId);
        const proof = await computeAuthProof(options.password, challenge.salt, challenge.iterations);
        if (!this.waitForAuthNotCancelled(batchId)) {
          // The receiver abandoned the prompt (or the sender cancelled) while
          // we were deriving the proof.
          const locallyCancelled = this.batchTombstones.has(batchId);
          for (const pending of pendingItems) {
            pending.status = locallyCancelled ? 'cancelled' : 'failed';
            pending.error = locallyCancelled
              ? 'Cancelled.'
              : 'The password step was not completed on the receiving device.';
            this.emit(pending, true);
          }
          return;
        }
        this.peer.sendText(serializeControl({ type: 'auth-verify', batchId, proof: [...proof] }));
        const ok = await resultPromise;
        if (ok) {
          key = await deriveSenderKey(options.password, challenge.salt, challenge.iterations);
          break;
        }
        if (attempt >= MAX_AUTH_ATTEMPTS || this.disposed) {
          // Fail the items already shown to the user (pre-consent cards keep
          // their ids; do not orphan them and create fresh ones).
          for (const pending of pendingItems) {
            pending.status = 'failed';
            pending.error = 'The receiving device reported the password did not match.';
            this.emit(pending, true);
          }
          return;
        }
        // Otherwise the receiver is retrying: wait for its next challenge.
      }
    }

    // 3. Stream every accepted item. Byte streaming is serialized per peer
    // through the stream gate, so two accepted batches never interleave
    // chunks on one data channel.
    const releaseGate = await this.waitForStreamGate();
    try {
      for (const acceptedEntry of accepted) {
        if (this.disposed || !this.peer.isChannelOpen() || this.transferCount >= MAX_TRANSFERS_PER_SESSION) return;
        await this.streamItem(batchId, acceptedEntry.entry, acceptedEntry.meta, key, acceptedEntry.transferId, acceptedEntry.item);
      }
    } finally {
      releaseGate();
    }
  }

  private failBatchLocally(metas: FileMeta[], message: string): void {
    for (const meta of metas) {
      const item = this.makeItem(generateTransferId(), meta.name, meta.size, 'outgoing');
      item.status = 'failed';
      item.error = message;
      this.emit(item, true);
    }
  }

  /**
   * Waits until no other batch is streaming on this peer's channel, then
   * returns a release function the caller must invoke (always, via finally)
   * when its last item settles.
   */
  private waitForStreamGate(): Promise<() => void> {
    const previous = this.streamGate;
    let release!: () => void;
    const claimed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.streamGate = previous.then(() => claimed);
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    return previous.then(() => releaseOnce);
  }

  private requestOfferDecision(batchId: string, offer: Extract<ControlMessage, { type: 'offer' }>): Promise<OfferResponse> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.offers.delete(batchId);
        resolve({ decision: 'declined' });
      }, OFFER_TIMEOUT_MS);
      this.offers.set(batchId, {
        offer: { batchId, secure: offer.secure, items: offer.items },
        resolve: (result) => {
          window.clearTimeout(timer);
          resolve(result);
        },
        timer,
      });
      this.peer.sendText(serializeControl(offer));
    });
  }

  /**
   * Arms a waiter for the receiver's auth-cancel frame. Returns false
   * immediately when the batch was already cancelled, so a sender racing a
   * receiver that abandoned the prompt never waits out the full timeout.
   */
  private waitForAuthNotCancelled(batchId: string): boolean {
    const auth = this.auths.get(batchId);
    if (auth?.cancelled) return false;
    auth?.challengeWaiter?.(null);
    return true;
  }

  private waitForAuthChallenge(batchId: string): Promise<{ salt: Uint8Array; iterations: number } | null> {
    // A tombstoned (cancelled/withdrawn) batch never receives a challenge.
    if (this.batchTombstones.has(batchId)) return Promise.resolve(null);
    const early = this.earlyChallenges.get(batchId);
    if (early) {
      this.earlyChallenges.delete(batchId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      let auth = this.auths.get(batchId);
      if (!auth) {
        auth = {
          timer: 0,
          expectedProof: null,
          key: null,
          challengeSent: false,
          challengeWaiter: null,
          resultWaiter: null,
          cancelled: false,
        };
        this.auths.set(batchId, auth);
      }
      const timer = window.setTimeout(() => {
        auth!.challengeWaiter = null;
        resolve(null);
      }, AUTH_TIMEOUT_MS);
      auth.challengeWaiter = (challenge) => {
        window.clearTimeout(timer);
        resolve(challenge);
      };
    });
  }

  private waitForAuthResult(batchId: string): Promise<boolean> {
    if (this.batchTombstones.has(batchId)) return Promise.resolve(false);
    const early = this.earlyResults.get(batchId);
    if (early !== undefined) {
      this.earlyResults.delete(batchId);
      this.auths.delete(batchId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const auth = this.auths.get(batchId);
      if (!auth) {
        resolve(false);
        return;
      }
      const timer = window.setTimeout(() => {
        auth.resultWaiter = null;
        resolve(false);
      }, AUTH_TIMEOUT_MS);
      auth.resultWaiter = (ok) => {
        window.clearTimeout(timer);
        this.auths.delete(batchId);
        resolve(ok);
      };
    });
  }

  private makeItem(transferId: string, name: string, size: number, direction: 'outgoing' | 'incoming'): TransferItem {
    return {
      transferId,
      peerId: '',
      peerName: null,
      direction,
      name,
      size,
      mimeType: 'application/octet-stream',
      status: 'active',
      bytesTransferred: 0,
      error: null,
      paused: false,
      secure: false,
      zipped: false,
      downloadUrl: null,
    };
  }

  // ---- receiver side -------------------------------------------------------

  /**
   * Entry point for every DataChannel frame. Frames are processed through a
   * serial promise chain: chunk decryption is async, and without ordering,
   * a file-end control frame could overtake the chunk still being
   * decrypted ahead of it.
   */
  handleData(data: string | ArrayBuffer): void {
    if (this.disposed) return;
    this.frameChain = this.frameChain
      .then(() => this.processData(data))
      .catch(() => undefined); // one bad frame never kills the chain
  }

  private async processData(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      const message = parseControlMessage(data);
      if (message) this.handleControl(message);
      return;
    }
    await this.handleChunk(data);
  }

  private handleControl(message: ControlMessage): void {
    switch (message.type) {
      case 'hello':
        this.events.onPeerName?.(message.name ? sanitizeDeviceName(message.name) : null);
        return;
      case 'offer':
        this.onOffer(message);
        return;
      case 'offer-response':
        this.onOfferResponse(message);
        return;
      case 'auth-challenge':
        this.onAuthChallenge(message);
        return;
      case 'auth-verify':
        this.onAuthVerify(message);
        return;
      case 'auth-result':
        this.onAuthResult(message);
        return;
      case 'auth-cancel':
        this.onAuthCancel(message);
        return;
      case 'text':
        this.events.onText({ id: message.id, text: message.text });
        return;
      case 'file-start':
        this.onFileStart(message);
        return;
      case 'file-end':
        this.onFileEnd(message.transferId);
        return;
      case 'transfer-ack':
        this.onAck(message.transferId);
        return;
      case 'transfer-cancel':
        this.onRemoteCancel(message.transferId);
        return;
      case 'transfer-error':
        this.onRemoteError(message.transferId, message.message);
        return;
    }
  }

  private onOffer(message: Extract<ControlMessage, { type: 'offer' }>): void {
    if (this.offers.size >= MAX_ITEMS_PER_PEER) {
      this.peer.sendText(serializeControl({ type: 'offer-response', batchId: message.batchId, decision: 'declined' }));
      return;
    }
    const offer: IncomingOffer = { batchId: message.batchId, secure: message.secure, items: message.items };
    this.batchSecure.set(message.batchId, message.secure);
    const timer = window.setTimeout(() => {
      if (this.offers.delete(message.batchId)) {
        this.events.onOfferSettled(message.batchId);
        this.peer.sendText(
          serializeControl({ type: 'offer-response', batchId: message.batchId, decision: 'declined' }),
        );
      }
    }, OFFER_TIMEOUT_MS);
    this.offers.set(message.batchId, {
      offer,
      timer,
      resolve: (response) => {
        window.clearTimeout(timer);
        // Always answer the sender on the wire first: its decision promise
        // must resolve so it can move on to the (optional) auth phase.
        const wire: ControlMessage = {
          type: 'offer-response',
          batchId: message.batchId,
          decision: response.decision,
          ...(response.selected !== undefined ? { items: response.selected } : {}),
        };
        this.peer.sendText(serializeControl(wire));
        if (response.decision === 'accepted' && message.secure) {
          // Secure batches: wait for the password UI, then challenge the
          // sender. The challenge goes out from submitPassword().
          const auth = this.ensureAuth(message.batchId);
          window.clearTimeout(auth.timer);
          auth.timer = window.setTimeout(() => {
            this.auths.delete(message.batchId);
          }, AUTH_TIMEOUT_MS);
          this.events.onPasswordRequired(message.batchId);
        }
      },
    });
    this.events.onOfferReceived(offer);
  }  private onOfferResponse(message: Extract<ControlMessage, { type: 'offer-response' }>): void {
    const pending = this.offers.get(message.batchId);
    if (!pending) {
      // No pending offer here means we already answered (accepted) and the
      // batch is in its password phase. A sender withdrawal must still tear
      // that phase down — otherwise the password prompt would hang around
      // for a batch that can never arrive.
      if (message.decision === 'declined' && message.withdrawn === true) {
        this.withdrawAcceptedBatch(message.batchId);
        this.events.onOfferWithdrawn?.(message.batchId);
      }
      return;
    }
    this.offers.delete(message.batchId);
    // The sender withdrew (cancelled) or the decision arrived twice: either
    // way the card must leave the receiver's UI instead of lingering forever.
    if (message.decision !== 'declined' || message.withdrawn !== true) {
      this.events.onOfferSettled(message.batchId);
    } else {
      this.events.onOfferWithdrawn?.(message.batchId);
    }
    pending.resolve({ decision: message.decision, selected: message.items, localCancel: message.withdrawn === true });
  }

  /**
   * Receiver side: a sender's withdrawal that raced past our own answer
   * (we accepted, the sender cancelled before any data flowed). Tears down
   * the accepted-but-not-yet-streaming batch so no password entry, auth
   * state or stale card survives it.
   */
  withdrawAcceptedBatch(batchId: string): void {
    this.cancelBatch(batchId, false);
    const auth = this.auths.get(batchId);
    if (auth) {
      window.clearTimeout(auth.timer);
      this.auths.delete(batchId);
    }
    this.rememberTombstone(batchId);
  }

  /** Receiver UI answers a pending offer. Returns false when the offer is gone. */
  respondToOffer(batchId: string, response: OfferResponse, password?: string): boolean {
    const pending = this.offers.get(batchId);
    if (!pending) return false;
    this.offers.delete(batchId);
    this.events.onOfferSettled(batchId);
    pending.resolve({ ...response, password });
    return true;
  }

  /**
   * Receiver UI submits the password for a secure batch; sends the challenge.
   * Never throws: derivation failures (unsupported browser, unset crypto)
   * surface as `false` so the UI can offer a retry instead of crashing.
   */
  async submitPassword(batchId: string, password: string): Promise<boolean> {
    // Teardown is final: a withdrawn/cancelled batch cannot be revived by a
    // late password entry, so no new auth state may be created for it.
    if (this.batchTombstones.has(batchId)) return false;
    let auth = this.auths.get(batchId);
    if (!auth) {
      // The offer's accept path should have created this entry. Re-create it
      // defensively so a desynchronized UI can never leave the password
      // prompt stuck with no challenge ever going out.
      auth = this.ensureAuth(batchId);
      window.clearTimeout(auth.timer);
      auth.timer = window.setTimeout(() => {
        this.auths.delete(batchId);
      }, AUTH_TIMEOUT_MS);
    }
    if (auth.challengeSent || auth.key !== null) return false;
    let derived: Awaited<ReturnType<typeof createAuthChallenge>>;
    try {
      derived = await createAuthChallenge(password);
    } catch {
      // No usable crypto on this origin (or a derivation failure): report
      // failure so the prompt re-opens with a clear error instead of hanging.
      return false;
    }
    auth.expectedProof = derived.expectedProof;
    auth.key = derived.key;
    auth.challengeSent = true;
    try {
      this.peer.sendText(
        serializeControl({
          type: 'auth-challenge',
          batchId,
          salt: [...derived.challenge.salt],
          iterations: derived.challenge.iterations,
        }),
      );
    } catch {
      // The channel died between UI and send: reset the entry so the user
      // can retry once the link returns instead of erroring forever.
      auth.expectedProof = null;
      auth.key = null;
      auth.challengeSent = false;
      return false;
    }
    return true;
  }

  private ensureAuth(batchId: string): PendingAuth {
    let auth = this.auths.get(batchId);
    if (!auth) {
      auth = {
        timer: 0,
        expectedProof: null,
        key: null,
        challengeSent: false,
        challengeWaiter: null,
        resultWaiter: null,
        cancelled: false,
      };
      this.auths.set(batchId, auth);
    }
    return auth;
  }

  private onAuthChallenge(message: Extract<ControlMessage, { type: 'auth-challenge' }>): void {
    const auth = this.auths.get(message.batchId);
    if (!auth || !auth.challengeWaiter) {
      // No waiter armed yet (receiver retried quickly): stash the challenge
      // so the next waitForAuthChallenge picks it up instead of dropping it.
      this.earlyChallenges.set(message.batchId, {
        salt: new Uint8Array(message.salt),
        iterations: message.iterations,
      });
      return;
    }
    const waiter = auth.challengeWaiter;
    auth.challengeWaiter = null;
    waiter({ salt: new Uint8Array(message.salt), iterations: message.iterations });
  }

  private onAuthVerify(message: Extract<ControlMessage, { type: 'auth-verify' }>): void {
    const auth = this.auths.get(message.batchId);
    if (!auth || !auth.expectedProof || !auth.key) return;
    const ok = verifyAuthProof(new Uint8Array(message.proof), auth.expectedProof);
    this.peer.sendText(serializeControl({ type: 'auth-result', batchId: message.batchId, ok }));
    if (ok) {
      window.clearTimeout(auth.timer);
    } else {
      // Wrong password: let the receiver retry instead of leaving the
      // password prompt stuck. The sender fails its pending items.
      auth.expectedProof = null;
      auth.key = null;
      auth.challengeSent = false;
      window.clearTimeout(auth.timer);
      auth.timer = window.setTimeout(() => {
        this.auths.delete(message.batchId);
      }, AUTH_TIMEOUT_MS);
      this.events.onAuthFailed?.(message.batchId);
    }
  }

  private onAuthCancel(message: Extract<ControlMessage, { type: 'auth-cancel' }>): void {
    // Sender side: the receiver abandoned the password prompt. Wake the
    // waiting handshake so the pending items fail promptly instead of
    // sitting at "waiting" until the 5-minute auth timeout.
    const auth = this.auths.get(message.batchId);
    if (auth) {
      auth.cancelled = true;
      window.clearTimeout(auth.timer);
      const waiter = auth.challengeWaiter;
      auth.challengeWaiter = null;
      waiter?.(null);
      const resultWaiter = auth.resultWaiter;
      auth.resultWaiter = null;
      resultWaiter?.(false);
      this.auths.delete(message.batchId);
    }
    // Also settle any still-pending offer on the sending side.
    const pending = this.offers.get(message.batchId);
    if (pending) {
      this.offers.delete(message.batchId);
      window.clearTimeout(pending.timer);
      pending.resolve({ decision: 'declined', localCancel: false });
    }
    this.events.onOfferWithdrawn?.(message.batchId);
  }

  /**
   * Receiver side: abandon the password prompt for a batch. Notifies the
   * sender via an explicit auth-cancel frame (its pending items fail
   * promptly) and clears local auth state.
   */
  cancelPassword(batchId: string): boolean {
    const auth = this.auths.get(batchId);
    if (!auth) return false;
    window.clearTimeout(auth.timer);
    this.auths.delete(batchId);
    this.rememberTombstone(batchId);
    if (this.peer.isChannelOpen()) {
      try {
        this.peer.sendText(serializeControl({ type: 'auth-cancel', batchId }));
      } catch {
        /* channel may already be gone */
      }
    }
    return true;
  }

  private onAuthResult(message: Extract<ControlMessage, { type: 'auth-result' }>): void {
    const auth = this.auths.get(message.batchId);
    if (!auth) {
      // A result racing ahead of its waiter (e.g. a localhost loop): hold it
      // briefly so the waiter's first check picks it up instead of hanging.
      this.earlyResults.set(message.batchId, message.ok);
      return;
    }
    const waiter = auth.resultWaiter;
    auth.resultWaiter = null;
    waiter?.(message.ok);
  }

  private onFileStart(message: Extract<ControlMessage, { type: 'file-start' }>): void {
    const auth = this.auths.get(message.batchId);
    // Keep the auth entry: a batch streams its files one by one, so files
    // 2..N of a secure batch still need the key. It is cleaned up when the
    // LAST item of the batch finishes (see finalizeFileEnd / failIncoming).
    if (auth && auth.key !== null) {
      window.clearTimeout(auth.timer);
      // Arm a fresh timeout so the entry cannot leak if the stream dies.
      auth.timer = window.setTimeout(() => {
        this.auths.delete(message.batchId);
      }, AUTH_TIMEOUT_MS);
    }
    if (this.incoming.size >= MAX_ITEMS_PER_PEER) {
      this.sendTransferError(message.transferId, 'Too many concurrent incoming transfers.');
      return;
    }
    const existing = this.incoming.get(message.transferId);
    if (existing) {
      // Resume: the sender restarted a transfer we already know about.
      existing.paused = false;
      if (existing.resumeTimer !== null) {
        window.clearTimeout(existing.resumeTimer);
        existing.resumeTimer = null;
      }
      return;
    }
    if (this.incoming.size >= MAX_ITEMS_PER_PEER) return;
    const item = this.makeItem(message.transferId, message.file.name, message.file.size, 'incoming');
    if (message.file.relativePath) item.name = message.file.relativePath;
    item.bytesTransferred = message.offset;
    item.secure = this.batchSecure.get(message.batchId) ?? auth?.key != null;
    item.zipped = message.file.mimeType === 'application/zip';
    const state: IncomingState = {
      item,
      meta: message.file,
      parts: [],
      chunksReceived: 0,
      key: auth?.key ?? null,
      paused: false,
      resumeTimer: null,
    };
    this.incoming.set(message.transferId, state);
    this.activeIncomingId = message.transferId;
    if (!this.meters.has(message.transferId)) this.meters.set(message.transferId, new RollingMeter());
    this.emit(item, true);
  }

  private async handleChunk(buffer: ArrayBuffer): Promise<void> {
    const id = this.activeIncomingId;
    if (!id) return; // Stray binary frame without file-start.
    const state = this.incoming.get(id);
    if (!state || state.item.status !== 'active') return;

    let payload = buffer;
    if (state.key) {
      const plain = await decryptChunk(state.key, buffer);
      if (plain === null) {
        this.sendTransferError(id, 'Decryption failed — the password did not match.');
        this.failIncoming(id, 'failed', 'Transfer data could not be decrypted.');
        return;
      }
      payload = plain;
    }

    const remaining = state.meta.size - state.item.bytesTransferred;
    if (payload.byteLength > state.meta.chunkSize || payload.byteLength > remaining) {
      this.sendTransferError(id, 'Received an oversized chunk.');
      this.failIncoming(id, 'failed', 'Transfer data was invalid.');
      return;
    }
    state.parts.push(payload);
    state.chunksReceived += 1;
    state.item.bytesTransferred += payload.byteLength;
    if (state.item.bytesTransferred > state.meta.size) {
      this.sendTransferError(id, 'Received more data than declared.');
      this.failIncoming(id, 'failed', 'Transfer data was invalid.');
      return;
    }
    this.emit(state.item, false);
  }

  private onFileEnd(transferId: string): void {
    const state = this.incoming.get(transferId);
    if (!state || state.item.status !== 'active') return;
    if (this.activeIncomingId === transferId) this.activeIncomingId = null;
    this.finalizeFileEnd(transferId);
  }

  private finalizeFileEnd(transferId: string): void {
    const state = this.incoming.get(transferId);
    if (!state || state.item.status !== 'active') return;

    if (state.item.bytesTransferred === state.meta.size && state.chunksReceived === state.meta.totalChunks) {
      this.assembleFile(transferId);
      return;
    }
    // Momentary reordering between the binary stream and the file-end control
    // frame is tolerated with one bounded retry; genuinely missing data fails
    // after the grace period.
    window.setTimeout(() => {
      const retry = this.incoming.get(transferId);
      if (!retry || retry.item.status !== 'active') return;
      if (retry.item.bytesTransferred !== retry.meta.size || retry.chunksReceived !== retry.meta.totalChunks) {
        this.sendTransferError(transferId, 'Transfer ended before all data arrived.');
        this.failIncoming(transferId, 'failed', 'The file did not arrive completely.');
        return;
      }
      this.assembleFile(transferId);
    }, 1000);
  }

  private assembleFile(transferId: string): void {
    const state = this.incoming.get(transferId);
    if (!state || state.item.status !== 'active') return;
    if (state.item.bytesTransferred !== state.meta.size || state.chunksReceived !== state.meta.totalChunks) return;

    const blob = new Blob(state.parts, { type: state.meta.mimeType });
    state.parts = [];
    // Environments without object URLs (test runners, hardened sandboxes)
    // still complete the transfer; only the direct Save link is unavailable.
    try {
      state.item.downloadUrl = URL.createObjectURL(blob);
    } catch {
      state.item.downloadUrl = null;
    }
    state.item.status = 'completed';
    this.incoming.delete(transferId);
    this.emit(state.item, true);
    try {
      this.peer.sendText(serializeControl({ type: 'transfer-ack', transferId }));
    } catch {
      /* ack is best-effort */
    }
  }

  private failIncoming(
    transferId: string,
    status: Extract<TransferStatus, 'cancelled' | 'failed'>,
    message: string,
  ): void {
    const state = this.incoming.get(transferId);
    if (!state) return;
    if (this.activeIncomingId === transferId) this.activeIncomingId = null;
    state.parts = [];
    state.item.status = status;
    state.item.error = message;
    this.incoming.delete(transferId);
    this.emit(state.item, true);
  }

  private sendTransferError(transferId: string, message: string): void {
    if (!this.peer.isChannelOpen()) return;
    try {
      this.peer.sendText(serializeControl({ type: 'transfer-error', transferId, message }));
    } catch {
      /* best-effort */
    }
  }

  private onRemoteCancel(transferId: string): void {
    if (this.incoming.has(transferId)) {
      this.failIncoming(transferId, 'cancelled', 'The sender cancelled this transfer.');
    }
    for (const state of this.outgoing.values()) {
      if (state.transferId === transferId) {
        state.cancelled = true;
        state.paused = false;
        state.item.status = 'cancelled';
        this.emit(state.item, true);
        state.notifyAck?.();
      }
    }
  }

  private onRemoteError(transferId: string, message: string): void {
    for (const state of this.outgoing.values()) {
      if (state.transferId === transferId) {
        state.item.status = 'failed';
        state.item.error = message;
        state.paused = false;
        this.emit(state.item, true);
        state.notifyAck?.();
      }
    }
    if (this.incoming.has(transferId)) {
      this.failIncoming(transferId, 'failed', message);
    }
  }

  private onAck(transferId: string): void {
    for (const state of this.outgoing.values()) {
      if (state.transferId === transferId) {
        state.acked = true;
        state.notifyAck?.();
      }
    }
  }

  // ---- sender streaming -----------------------------------------------------

  /**
   * Streams one file with backpressure, worker-based chunk reads and
   * optional AES-GCM encryption. The loop is event-driven — it resumes only
   * on buffer-drain events — so throttled background tabs never stall it.
   */
  private async streamItem(
    batchId: string,
    entry: OutgoingEntry,
    meta: FileMeta,
    key: AesKey | null,
    transferId?: string,
    existingItem?: TransferItem,
  ): Promise<void> {
    const id = transferId ?? generateTransferId();
    this.transferCount += 1;
    const item = existingItem ?? this.makeItem(id, meta.name, meta.size, 'outgoing');
    if (!existingItem && meta.relativePath) item.name = meta.relativePath;
    item.transferId = id;
    item.status = 'active';
    item.error = null;
    const state: OutgoingState = {
      item,
      file: entry.file,
      meta,
      transferId: id,
      batchId,
      offset: 0,
      cancelled: false,
      paused: false,
      loopActive: false,
      acked: false,
      notifyAck: null,
      key,
      resumeTimer: null,
    };
    this.outgoing.set(id, state);
    if (!this.meters.has(id)) this.meters.set(id, new RollingMeter());
    this.emit(item, true);

    try {
      await this.runSendLoop(state);
    } catch (err) {
      if (state.cancelled || state.paused) {
        state.item.status = state.paused ? 'queued' : 'cancelled';
        this.emit(state.item, true);
      } else {
        state.item.status = 'failed';
        state.item.error = err instanceof Error ? err.message : 'Transfer failed.';
        this.emit(state.item, true);
      }
    } finally {
      this.outgoing.delete(id);
    }
  }

  private async runSendLoop(state: OutgoingState): Promise<void> {
    if (state.loopActive) return; // a paused loop is still alive and will continue
    state.loopActive = true;
    const { meta } = state;
    try {
      this.peer.sendText(
        serializeControl({
          type: 'file-start',
          batchId: state.batchId,
          transferId: state.transferId,
          file: meta,
          offset: state.offset,
        }),
      );
      while (state.offset < meta.size) {
        if (state.cancelled) return;
        if (state.paused) {
          await this.waitForResume(state);
          if (state.cancelled) return;
          continue;
        }
        if (this.disposed) throw new Error('Session disposed.');
        if (!this.peer.isChannelOpen()) {
          // Link lost mid-transfer: park the transfer as queued for resume
          // instead of failing it; the session re-runs queued items when the
          // connection returns.
          this.resuming = true;
          state.paused = true;
          state.item.paused = false; // auto-parked, not user-paused
          state.item.status = 'queued';
          state.item.error = 'Paused — waiting for the connection to return.';
          this.emit(state.item, true);
          return;
        }
        if (this.peer.getBufferedAmount() > BUFFER_HIGH_WATER) {
          await this.peer.waitForBufferDrain(BUFFER_LOW_WATER);
          continue; // re-check paused/cancelled after waiting
        }
        const length = Math.min(CHUNK_SIZE, meta.size - state.offset);
        let buffer = await this.chunkSource.read({ ...meta, file: state.file }, state.offset, length);
        if (buffer.byteLength === 0) {
          throw new Error('The file ended before the transfer completed.');
        }
        if (state.key) {
          buffer = await encryptChunk(state.key, buffer);
        }
        this.peer.sendBinary(buffer);
        state.offset += Math.min(length, buffer.byteLength);
        state.item.bytesTransferred = Math.min(state.offset, meta.size);
        this.emit(state.item, false);
      }
      await this.peer.flushWrites();
      this.peer.sendText(serializeControl({ type: 'file-end', transferId: state.transferId }));
      await this.waitForAck(state, ACK_TIMEOUT_MS);
      if (!state.cancelled && state.item.status === 'active') {
        state.item.status = 'completed';
        state.item.bytesTransferred = meta.size;
        this.emit(state.item, true);
      }
    } finally {
      state.loopActive = false;
    }
  }

  private waitForResume(state: OutgoingState): Promise<void> {
    return new Promise((resolve) => {
      const check = window.setInterval(() => {
        if (state.cancelled || !state.paused) {
          window.clearInterval(check);
          resolve();
        }
      }, 250);
    });
  }

  /** Pauses an outgoing transfer; it stays resumable until it expires. */
  pauseTransfer(transferId: string): boolean {
    const state = this.findOutgoing(transferId);
    if (!state || state.item.status !== 'active') return false;
    state.paused = true;
    state.item.paused = true;
    state.item.status = 'queued';
    state.item.error = 'Paused.';
    if (state.resumeTimer === null) {
      state.resumeTimer = window.setTimeout(() => {
        state.paused = false;
        // Block the parked send loop from waking up and resurrecting the
        // transfer after it is declared failed below.
        state.cancelled = true;
        if (state.item.status === 'queued') {
          state.item.status = 'failed';
          state.item.error = 'Transfer was paused for too long.';
        }
        this.emit(state.item, true);
      }, RESUME_TIMEOUT_MS);
    }
    this.emit(state.item, true);
    return true;
  }

  /** Resumes a paused outgoing transfer from its last byte offset. */
  resumeTransfer(transferId: string): boolean {
    const state = this.findOutgoing(transferId);
    if (!state || state.item.status !== 'queued' || !state.paused) return false;
    state.paused = false;
    state.item.paused = false;
    if (state.resumeTimer !== null) {
      window.clearTimeout(state.resumeTimer);
      state.resumeTimer = null;
    }
    state.item.status = 'active';
    state.item.error = null;
    this.emit(state.item, true);
    void this.runSendLoop(state).catch(() => {
      /* failures are surfaced through the item status */
    });
    return true;
  }

  private findOutgoing(transferId: string): OutgoingState | undefined {
    for (const state of this.outgoing.values()) {
      if (state.transferId === transferId) return state;
    }
    return undefined;
  }

  private waitForAck(state: OutgoingState, timeoutMs: number): Promise<void> {
    if (state.acked) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        state.notifyAck = null;
        resolve();
      }, timeoutMs);
      state.notifyAck = () => {
        window.clearTimeout(timer);
        state.notifyAck = null;
        resolve();
      };
    });
  }

  // ---- public actions -------------------------------------------------------

  sendTextMessage(text: string): { id: string } {
    const id = generateTransferId();
    this.peer.sendText(serializeControl({ type: 'text', id, text }));
    return { id };
  }

  cancelTransfer(transferId: string, notifyRemote = true): void {
    // Items still awaiting the receiver's consent live outside the outgoing
    // map; cancelling one withdraws the whole pending offer.
    const consentBatch = this.consentBatches.get(transferId);
    if (consentBatch) {
      this.cancelBatch(consentBatch, true);
      return;
    }
    const state = this.findOutgoing(transferId);
    if (state) {
      state.cancelled = true;
      state.paused = false;
      state.item.status = 'cancelled';
      this.emit(state.item, true);
      if (state.notifyAck) state.notifyAck();
    }
    if (this.incoming.has(transferId)) {
      this.failIncoming(transferId, 'cancelled', 'Transfer was cancelled.');
    }
    if (notifyRemote && this.peer.isChannelOpen()) {
      try {
        this.peer.sendText(serializeControl({ type: 'transfer-cancel', transferId, reason: 'cancelled-by-user' }));
      } catch {
        /* channel may already be gone */
      }
    }
  }

  /**
   * Declines a pending offer. On the receiver side this is the user's
   * decline; on the sender side (localCancel) it withdraws the offer and
   * tells the receiver to drop its card immediately.
   */
  cancelBatch(batchId: string, localCancel = false): void {
    const pending = this.offers.get(batchId);
    if (pending) {
      this.offers.delete(batchId);
      window.clearTimeout(pending.timer);
      pending.resolve({ decision: 'declined', localCancel });
    }
    if (this.peer.isChannelOpen()) {
      try {
        this.peer.sendText(
          serializeControl(
            localCancel
              ? { type: 'offer-response', batchId, decision: 'declined', withdrawn: true }
              : { type: 'offer-response', batchId, decision: 'declined' },
          ),
        );
      } catch {
        /* channel may already be gone */
      }
    }
    if (localCancel) {
      // Secure batches the receiver already accepted: also cancel any auth
      // handshake state so a later password entry cannot revive the batch,
      // and wake the sender's parked handshake so it fails/cancels at once
      // instead of sitting at "waiting" until the auth timeout.
      const auth = this.auths.get(batchId);
      if (auth) {
        auth.cancelled = true;
        window.clearTimeout(auth.timer);
        const challengeWaiter = auth.challengeWaiter;
        auth.challengeWaiter = null;
        challengeWaiter?.(null);
        const resultWaiter = auth.resultWaiter;
        auth.resultWaiter = null;
        resultWaiter?.(false);
        this.auths.delete(batchId);
      }
      this.rememberTombstone(batchId);
    }
  }

  /** Marks a batch as dead so late password entry can never resurrect it. */
  private rememberTombstone(batchId: string): void {
    if (this.batchTombstones.size >= MAX_BATCH_TOMBSTONES) {
      const oldest = this.batchTombstones.values().next().value;
      if (oldest !== undefined) this.batchTombstones.delete(oldest);
    }
    this.batchTombstones.add(batchId);
  }

  // ---- shared ------------------------------------------------------------

  private emit(item: TransferItem, force: boolean): void {
    const now = performance.now();
    const last = this.emitTimes.get(item.transferId) ?? 0;
    if (!force && now - last < PROGRESS_EMIT_INTERVAL_MS) return;
    this.emitTimes.set(item.transferId, now);
    this.events.onTransferUpdate({ ...item });
  }

  statsFor(transferId: string, bytesTransferred: number, total: number): { bytesPerSecond: number; etaSeconds: number | null } {
    let meter = this.meters.get(transferId);
    if (!meter) {
      meter = new RollingMeter();
      this.meters.set(transferId, meter);
    }
    const speed = meter.sample(performance.now(), bytesTransferred);
    const remaining = Math.max(0, total - bytesTransferred);
    return { bytesPerSecond: speed, etaSeconds: speed > 0 ? remaining / speed : null };
  }

  /**
   * Fails every in-flight transfer when the connection drops. Queued batches
   * are retried when a new connection arrives; completed offsets of parked
   * transfers are retained by the session layer.
   */
  abortInFlight(reason: string): void {
    this.resuming = false;
    for (const [, state] of this.outgoing) {
      if (state.item.status === 'active') {
        state.paused = true;
        state.item.paused = false; // auto-parked; resumeQueued() restarts it
        state.item.status = 'queued';
        state.item.error = reason;
        this.emit(state.item, true);
      }
      state.notifyAck?.();
    }
    for (const [id] of this.incoming) this.failIncoming(id, 'failed', reason);
    this.incoming.clear();
    this.activeIncomingId = null;
  }

  /** Re-runs parked transfers after a reconnect; returns true when work resumed. */
  resumeQueued(): boolean {
    if (this.disposed || !this.peer.isChannelOpen()) return false;
    this.resuming = false;
    let resumed = false;
    for (const state of this.outgoing.values()) {
      // Only auto-parked transfers resume by themselves; user-paused ones
      // (item.paused) wait for the explicit Resume action.
      if (state.item.status === 'queued' && !state.item.paused) {
        resumed = true;
        state.paused = false;
        state.item.status = 'active';
        state.item.error = null;
        this.emit(state.item, true);
        void this.runSendLoop(state).catch(() => {
          /* failures are surfaced through the item status */
        });
      }
    }
    return resumed;
  }

  hasPendingQueue(): boolean {
    return this.queue.length > 0;
  }

  /** Removes and returns queued batches (used when a connection drops). */
  drainQueue(): { entries: OutgoingEntry[]; options: SendOptions }[] {
    return this.queue.splice(0, this.queue.length);
  }

  /** True while any transfer is actively streaming on this connection. */
  hasActiveWork(): boolean {
    for (const state of this.outgoing.values()) {
      if (state.item.status === 'active') return true;
    }
    return this.incoming.size > 0;
  }

  /** Cancels everything in flight and releases resources. */
  dispose(): void {
    this.disposed = true;
    for (const [, state] of this.outgoing) {
      state.cancelled = true;
      state.item.status = 'cancelled';
      this.emit(state.item, true);
    }
    for (const [id] of this.incoming) this.failIncoming(id, 'failed', 'Connection closed.');
    for (const [, pending] of this.offers) {
      window.clearTimeout(pending.timer);
      pending.resolve({ decision: 'declined' });
    }
    for (const [, auth] of this.auths) window.clearTimeout(auth.timer);
    this.outgoing.clear();
    this.incoming.clear();
    this.offers.clear();
    this.auths.clear();
    this.meters.clear();
    this.consentBatches.clear();
    this.batchSecure.clear();
    this.earlyChallenges.clear();
    this.earlyResults.clear();
    this.batchTombstones.clear();
    this.queue.length = 0;
    this.chunkSource.dispose();
  }
}
