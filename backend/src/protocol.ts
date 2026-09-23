import { z } from 'zod';
import { normalizeRoomId } from './roomId.js';

/**
 * Signaling protocol
 * ------------------
 * All messages are JSON objects with a string `type` field. Clients send
 * ClientMessages; the server replies with ServerMessages. Nothing else is
 * accepted. Every inbound frame is parsed through a strict zod schema before
 * it reaches application code; SDP payloads and ICE candidates are validated
 * for shape and size and relayed verbatim to the other peers in the room.
 */

export const PROTOCOL_VERSION = 1;
export const PEER_ID_LENGTH = 12;
export const MAX_SDP_LENGTH = 32 * 1024;
/** Hard cap for the user-chosen device name carried in create/join frames. */
export const MAX_DEVICE_NAME_LENGTH = 40;

export const ERROR_CODES = [
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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface RoomCreatedMessage {
  type: 'room-created';
  roomId: string;
  peerId: string;
  expiresAt: number;
  deviceNames: string[]; // All device names in the room (including self)
}

export interface RoomJoinedMessage {
  type: 'room-joined';
  roomId: string;
  peerId: string;
  peers: string[];
  deviceNames: Record<string, string>; // peerId -> deviceName (serializable)
  expiresAt: number;
}

export interface PeerJoinedMessage {
  type: 'peer-joined';
  peerId: string;
  /** Device name the newcomer registered with (already sanitized server-side). */
  deviceName?: string;
}

export interface PeerLeftMessage {
  type: 'peer-left';
  peerId: string;
}

export interface SignalMessage {
  type: 'signal';
  from: string;
  sdp?: string;
  candidate?: unknown;
}

export interface RoomExpiredMessage {
  type: 'room-expired';
  roomId: string;
}

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | SignalMessage
  | RoomExpiredMessage
  | ErrorMessage;

export interface ValidCreateRoom {
  kind: 'create-room';
  /** User-chosen device name; enforced unique per room by the server. */
  deviceName?: string;
}

export interface ValidJoinRoom {
  kind: 'join-room';
  roomId: string;
  /** User-chosen device name; enforced unique per room by the server. */
  deviceName?: string;
}

export interface ValidSignal {
  kind: 'signal';
  to: string;
  sdp?: string;
  candidate?: unknown;
}

export type ValidClientMessage = ValidCreateRoom | ValidJoinRoom | ValidSignal;

const PEER_ID_PATTERN = /^[A-Za-z0-9]{12}$/;

const peerIdSchema = z.string().regex(PEER_ID_PATTERN);

/**
 * Device names are user-chosen and end up rendered next to transfers, so they
 * are validated hard: no control or format characters (visual spoofing), no
 * line separators, bounded length. Matching logic on the server is a plain
 * case-insensitive compare of this sanitized value.
 */
export function sanitizeDeviceName(raw: string): string | null {
  let out = '';
  for (const ch of raw) {
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch)) continue;
    out += ch;
  }
  const trimmed = out.trim().slice(0, MAX_DEVICE_NAME_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : null;
}

const deviceNameSchema = z
  .string()
  .max(MAX_DEVICE_NAME_LENGTH * 4) // reject absurd input before sanitizing
  .transform((raw) => sanitizeDeviceName(raw))
  .refine((name) => name !== null, { message: 'Device name is empty or invalid.' });

/**
 * ICE candidate: an object whose `candidate` field is either a string
 * (SDP line) or null (end-of-candidates), with optional bounded metadata.
 */
const iceCandidateSchema = z
  .object({
    candidate: z.union([z.string().max(1024), z.null()]).optional(),
    sdpMid: z.union([z.string().max(64), z.null()]).optional(),
    sdpMLineIndex: z.number().int().min(0).max(100).nullable().optional(),
    usernameFragment: z.string().max(64).optional(),
  })
  .passthrough()
  .refine(
    (value) =>
      value.candidate !== undefined ||
      value.sdpMid !== undefined ||
      value.sdpMLineIndex !== undefined,
    { message: 'ICE candidate object is empty.' },
  );

const signalPayloadSchema = z
  .object({
    to: peerIdSchema,
    sdp: z.string().max(MAX_SDP_LENGTH).optional(),
    candidate: iceCandidateSchema.optional(),
  })
  .strict()
  .refine((value) => value.sdp !== undefined || value.candidate !== undefined, {
    message: 'Signal message needs an "sdp" or "candidate" field.',
  });

/** Strict runtime schema for one raw WebSocket text frame. */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create-room'), deviceName: deviceNameSchema.optional() }).strict(),
  z
    .object({
      type: z.literal('join-room'),
      roomId: z.string(),
      deviceName: deviceNameSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('signal'),
      to: z.string(),
      sdp: z.string().max(MAX_SDP_LENGTH).optional(),
      candidate: z.unknown().optional(),
    })
    .strict(),
]);

/**
 * Parses and validates one raw WebSocket text frame. Returns a discriminated
 * result — never throws.
 */
export function parseClientMessage(
  raw: string,
  maxBytes: number,
):
  | { ok: true; message: ValidClientMessage }
  | { ok: false; code: ErrorCode; message: string } {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return { ok: false, code: 'MESSAGE_TOO_LARGE', message: 'Signaling message exceeds the size limit.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'MALFORMED_MESSAGE', message: 'Message is not valid JSON.' };
  }

  // Oversized SDP is a size problem, not a shape problem: classify it as
  // MESSAGE_TOO_LARGE even though the zod schema would also reject it.
  if (typeof parsed === 'object' && parsed !== null && 'sdp' in parsed) {
    const sdp = (parsed as { sdp?: unknown }).sdp;
    if (typeof sdp === 'string' && sdp.length > MAX_SDP_LENGTH) {
      return { ok: false, code: 'MESSAGE_TOO_LARGE', message: 'SDP payload exceeds the size limit.' };
    }
  }

  const checked = clientMessageSchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const pathText = issue && issue.path.length > 0 ? ` ("${issue.path.join('.')}")` : '';
    const detail = issue?.message ?? 'Message shape is not valid.';
    if (pathText.length > 0 && detail.length > 0) {
      return { ok: false, code: 'PROTOCOL_ERROR', message: `Message${pathText}: ${detail}.` };
    }
    return { ok: false, code: 'PROTOCOL_ERROR', message: detail };
  }

  switch (checked.data.type) {
    case 'create-room':
      return { ok: true, message: { kind: 'create-room', ...(checked.data.deviceName ? { deviceName: checked.data.deviceName } : {}) } };

    case 'join-room': {
      const roomId = normalizeRoomId(checked.data.roomId);
      if (roomId === null) {
        return { ok: false, code: 'PROTOCOL_ERROR', message: 'The room code is not valid.' };
      }
      return {
        ok: true,
        message: {
          kind: 'join-room',
          roomId,
          ...(checked.data.deviceName ? { deviceName: checked.data.deviceName } : {}),
        },
      };
    }

    case 'signal': {
      // Strip the discriminant before payload validation: the strict payload
      // schema must not see the `type` field it does not declare.
      const { type: _discriminant, ...payloadFields } = checked.data;
      const payload = signalPayloadSchema.safeParse(payloadFields);
      if (!payload.success) {
        const issue = payload.error.issues[0];
        const path = issue?.path.filter((p) => p !== 'candidate' && p !== 'sdp') ?? [];
        if (path.includes('to')) {
          return { ok: false, code: 'PROTOCOL_ERROR', message: 'Signal target peer id is not valid.' };
        }
        const message = issue?.message ?? 'Signal payload is not valid.';
        return { ok: false, code: 'PROTOCOL_ERROR', message };
      }
      const signal: ValidSignal = { kind: 'signal', to: payload.data.to };
      if (payload.data.sdp !== undefined) signal.sdp = payload.data.sdp;
      if (payload.data.candidate !== undefined) signal.candidate = payload.data.candidate;
      return { ok: true, message: signal };
    }
  }
}

export function serializeMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
