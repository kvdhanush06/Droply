import type { IceServerConfig, PeerConnectionState } from '../../types';
import { TRANSFER_PROTOCOL } from '../transfer/protocol';

const ICE_RESTART_DELAY_MS = 4000;

export interface PeerConnectionEvents {
  onStateChange: (state: PeerConnectionState) => void;
  onData: (data: string | ArrayBuffer) => void;
  onSignalOffer: (sdp: string) => void;
  onSignalAnswer: (sdp: string) => void;
  onSignalCandidate: (candidate: RTCIceCandidateInit | null) => void;
  onDataChannelOpen: () => void;
}

function mapState(state: RTCPeerConnectionState, restarting: boolean): PeerConnectionState {
  switch (state) {
    case 'new':
      return 'new';
    case 'connecting':
      return restarting ? 'reconnecting' : 'connecting';
    case 'connected':
      return 'connected';
    case 'disconnected':
      return restarting ? 'reconnecting' : 'disconnected';
    case 'failed':
      return restarting ? 'reconnecting' : 'failed';
    case 'closed':
      return 'closed';
  }
}

/**
 * Owns one RTCPeerConnection plus its single ordered, reliable DataChannel.
 * All signaling I/O is delegated to the caller through the `onSignal*`
 * callbacks, keeping this class free of networking concerns.
 */
export class PeerConnection {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private readonly events: PeerConnectionEvents;
  private readonly iceServers: IceServerConfig[];
  private state: PeerConnectionState = 'new';
  private restarting = false;
  private iceRestartTimer: number | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private closed = false;

  constructor(iceServers: IceServerConfig[], events: PeerConnectionEvents) {
    this.iceServers = iceServers;
    this.events = events;
  }

  getState(): PeerConnectionState {
    return this.state;
  }

  isChannelOpen(): boolean {
    return this.channel !== null && this.channel.readyState === 'open';
  }

  /** The polite side (joiner) waits for the channel created by the impolite side. */
  init(polite: boolean): void {
    this.teardownPc();
    this.closed = false;
    this.pendingCandidates = [];
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    this.pc = pc;

    pc.onicecandidate = (event) => {
      // Skip the end-of-candidates null: our signaling server rejects frames
      // with neither sdp nor candidate.
      if (event.candidate) {
        this.events.onSignalCandidate(event.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.closed || !this.pc) return;
      const raw = pc.connectionState;
      if (raw === 'failed' && !polite && !this.restarting) {
        this.startIceRestart();
      }
      this.setState(mapState(raw, this.restarting));
    };

    pc.ondatachannel = (event) => {
      this.attachChannel(event.channel);
    };

    if (!polite) {
      const channel = pc.createDataChannel(TRANSFER_PROTOCOL, { ordered: true });
      channel.binaryType = 'arraybuffer';
      this.attachChannel(channel);
      void this.createAndSendOffer();
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    this.channel = channel;
    channel.onopen = () => {
      this.events.onDataChannelOpen();
    };
    channel.onmessage = (event) => {
      const data = event.data as unknown;
      if (typeof data === 'string') {
        this.events.onData(data);
      } else if (data instanceof ArrayBuffer) {
        this.events.onData(data);
      } else if (data instanceof Blob) {
        void data.arrayBuffer().then((buf) => this.events.onData(buf));
      }
    };
    channel.onerror = () => {
      // State is surfaced through connectionState changes.
    };
  }

  private async createAndSendOffer(options?: RTCOfferOptions): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    try {
      const offer = await pc.createOffer(options);
      await pc.setLocalDescription(offer);
      if (pc.localDescription) this.events.onSignalOffer(pc.localDescription.sdp);
    } catch {
      this.setState('failed');
    }
  }

  async handleOffer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (pc.localDescription) this.events.onSignalAnswer(pc.localDescription.sdp);
      await this.flushPendingCandidates();
    } catch {
      this.setState('failed');
    }
  }

  async handleAnswer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      await this.flushPendingCandidates();
    } catch {
      this.setState('failed');
    }
  }

  async handleCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    if (candidate === null) return; // End-of-candidates signal.
    if (!pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      // Stale or duplicate candidates are not fatal.
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      await this.handleCandidate(candidate);
    }
  }

  private startIceRestart(): void {
    this.restarting = true;
    void this.createAndSendOffer({ iceRestart: true });
    if (this.iceRestartTimer !== null) window.clearTimeout(this.iceRestartTimer);
    this.iceRestartTimer = window.setTimeout(() => {
      if (this.restarting) {
        this.restarting = false;
        this.setState('failed');
      }
    }, ICE_RESTART_DELAY_MS);
  }

  sendText(payload: string): void {
    if (!this.isChannelOpen()) throw new Error('Data channel is not open.');
    this.channel!.send(payload);
  }

  sendBinary(buffer: ArrayBuffer): void {
    if (!this.isChannelOpen()) throw new Error('Data channel is not open.');
    try {
      this.channel!.send(buffer);
    } catch {
      // Fall back to a copied view: some browsers reject a detached or
      // neutered buffer instead of queueing it.
      this.channel!.send(new Uint8Array(buffer).slice().buffer);
    }
  }

  /** Flushes any frames still queued in the SCTP stack before sending text. */
  async flushWrites(): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') return;
    if (channel.bufferedAmount === 0) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error('Timed out flushing data channel.'));
        }, 30_000);
        const cleanup = () => {
          window.clearTimeout(timeout);
          channel.removeEventListener('bufferedamountlow', onLow);
        };
        const onLow = () => {
          cleanup();
          resolve();
        };
        channel.bufferedAmountLowThreshold = 0;
        channel.addEventListener('bufferedamountlow', onLow);
      });
    } catch {
      /* best-effort: the receiver still validates counts at file-end */
    }
  }

  getBufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  /**
   * Resolves once the channel's buffered amount falls to or below `threshold`.
   * Used by the file sender for backpressure.
   */
  waitForBufferDrain(threshold: number): Promise<void> {
    const channel = this.channel;
    return new Promise((resolve, reject) => {
      if (!channel || channel.readyState !== 'open') {
        reject(new Error('Data channel closed.'));
        return;
      }
      if (channel.bufferedAmount <= threshold) {
        resolve();
        return;
      }
      channel.bufferedAmountLowThreshold = threshold;
      const onLow = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        resolve();
      };
      const onClose = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        reject(new Error('Data channel closed while draining.'));
      };
      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onClose);
    });
  }

  private setState(state: PeerConnectionState): void {
    if (state === 'connected' && this.restarting) {
      this.restarting = false;
      if (this.iceRestartTimer !== null) {
        window.clearTimeout(this.iceRestartTimer);
        this.iceRestartTimer = null;
      }
    }
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange(state);
  }

  private teardownPc(): void {
    if (this.iceRestartTimer !== null) {
      window.clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = null;
    }
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onmessage = null;
      this.channel.onerror = null;
      try {
        this.channel.close();
      } catch {
        /* ignore */
      }
      this.channel = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.ondatachannel = null;
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownPc();
    this.setState('closed');
  }
}
