/** Shared type definitions for the Droply frontend. */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface ServerPublicConfig {
  iceServers: IceServerConfig[];
  maxRoomPeers: number;
  roomTtlSeconds: number;
}

/** Messages accepted by the signaling server (client -> server). */
export type SignalingOutgoing =
  | { type: 'create-room'; deviceName?: string }
  | { type: 'join-room'; roomId: string; deviceName?: string }
  | { type: 'signal'; to: string; sdp?: string; candidate?: RTCIceCandidateInit | null };

export type SignalingErrorCode =
  | 'PROTOCOL_ERROR'
  | 'MALFORMED_MESSAGE'
  | 'MESSAGE_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'NOT_IN_ROOM'
  | 'ALREADY_IN_ROOM'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_LIMIT_REACHED'
  | 'UNKNOWN_PEER'
  | 'PEER_NOT_FOUND'
  | 'SERVER_SHUTTING_DOWN'
  | 'NAME_EXISTS';

/** Messages sent by the signaling server (server -> client). */
export type SignalingIncoming =
  | { type: 'room-created'; roomId: string; peerId: string; expiresAt: number; deviceNames?: string[] }
  | { type: 'room-joined'; roomId: string; peerId: string; peers: string[]; expiresAt: number; deviceNames?: Record<string, string> }
  | { type: 'peer-joined'; peerId: string; deviceName?: string }
  | { type: 'peer-left'; peerId: string }
  | { type: 'signal'; from: string; sdp?: string; candidate?: RTCIceCandidateInit | null }
  | { type: 'room-expired'; roomId: string }
  | { type: 'error'; code: SignalingErrorCode; message: string };

export type SignalingState = 'idle' | 'connecting' | 'open' | 'closed';

export type PeerConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface PeerInfo {
  peerId: string;
  state: PeerConnectionState;
  /** Self-declared device name exchanged over the data channel (untrusted). */
  name: string | null;
}

export type RoomStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'connecting-peers'
  | 'ready'
  | 'reconnecting'
  | 'expired'
  | 'error';

export type TransferStatus =
  | 'queued'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type TransferDirection = 'outgoing' | 'incoming';

export interface TransferStats {
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export interface TransferItem {
  transferId: string;
  peerId: string;
  /** Display name of the other device, when known. */
  peerName: string | null;
  direction: TransferDirection;
  name: string;
  size: number;
  mimeType: string;
  status: TransferStatus;
  bytesTransferred: number;
  error: string | null;
  /** True while a queued outgoing transfer was paused (vs. awaiting consent). */
  paused: boolean;
  /** True when the batch is password-protected end to end. */
  secure: boolean;
  /** True when the item is a zipped bundle produced by the zip option. */
  zipped: boolean;
  /** Populated for completed incoming transfers. */
  downloadUrl: string | null;
}

export interface ConversationEntry {
  id: string;
  direction: TransferDirection;
  text: string;
  receivedAt: number;
}

/** One file declared in a sender's consent offer. */
export interface OfferItem {
  name: string;
  relativePath?: string;
  size: number;
  mimeType: string;
}

/** A pending consent request from a sender device. */
export interface OfferEntry {
  batchId: string;
  peerId: string;
  /** Sender's device name at offer time, when known. */
  senderName: string | null;
  secure: boolean;
  items: OfferItem[];
}

/** A pending password prompt on the receiving device. */
export interface PasswordPromptEntry {
  batchId: string;
  peerId: string;
  /** Sender's device name, when known. */
  senderName: string | null;
  /** Set after a wrong password so the receiver can retry. */
  error: string | null;
}
