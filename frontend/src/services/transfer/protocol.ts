import { z } from 'zod';
import { PROTOCOL_VERSION, TRANSFER_PROTOCOL } from './constants';

export const CHUNK_SIZE = 16 * 1024;

export const MAX_TEXT_LENGTH = 100_000;
export const MAX_FILE_NAME_LENGTH = 255;
/** Upper bound accepted for a single file; guards against absurd metadata. */
export const MAX_FILE_SIZE = 16 * 1024 * 1024 * 1024; // 16 GiB
export const MAX_TRANSFERS_PER_SESSION = 10_000;
/** Upper bound for a sender-side queued batch. */
export const MAX_QUEUE_FILES = 5_000;
/** Upper bound for items declared in one offer. */
export const MAX_OFFER_ITEMS = 5_000;
/** Limit for the UTF-8 encoded offer frame itself. */
export const MAX_OFFER_BYTES = 2 * 1024 * 1024;
/** Upper bound for the sender batch id. */
export const MAX_BATCH_ID_LENGTH = 40;
/** Salt and key lengths for the password handshake. */
export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
export const PBKDF2_ITERATIONS = 250_000;
/** Upper bound for a challenge nonce. */
export const NONCE_BYTES = 16;

const TRANSFER_ID_LENGTH = 10;
const TRANSFER_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateTransferId(
  rand: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32,
): string {
  let id = '';
  for (let i = 0; i < TRANSFER_ID_LENGTH; i += 1) {
    id += TRANSFER_ID_ALPHABET[Math.floor(rand() * TRANSFER_ID_ALPHABET.length)];
  }
  return id;
}

export interface FileMeta {
  name: string;
  relativePath?: string;
  size: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
}

export type OfferDecision = 'accepted' | 'declined';

export type ControlMessage =
  | { type: 'hello'; protocol: number; name?: string }
  | { type: 'offer'; batchId: string; secure: boolean; items: FileMeta[] }
  | { type: 'offer-response'; batchId: string; decision: OfferDecision; items?: number[]; withdrawn?: boolean }
  | { type: 'auth-challenge'; batchId: string; salt: number[]; iterations: number }
  | { type: 'auth-verify'; batchId: string; proof: number[] }
  | { type: 'auth-result'; batchId: string; ok: boolean }
  | { type: 'auth-cancel'; batchId: string }
  | { type: 'file-start'; batchId: string; transferId: string; file: FileMeta; offset: number }
  | { type: 'file-end'; transferId: string }
  | { type: 'transfer-ack'; transferId: string }
  | { type: 'transfer-cancel'; transferId: string; reason?: string }
  | { type: 'transfer-error'; transferId: string; message: string }
  | { type: 'text'; id: string; text: string };

/* ------------------------------------------------------------------ */
/* Zod schemas — every inbound control frame is validated strictly.   */
/* ------------------------------------------------------------------ */

const transferIdSchema = z.string().regex(/^[A-Za-z0-9]{6,24}$/);
const batchIdSchema = z.string().min(6).max(MAX_BATCH_ID_LENGTH).regex(/^[A-Za-z0-9-]+$/);

const fileMetaSchema = z
  .object({
    name: z.string().min(1).max(MAX_FILE_NAME_LENGTH).transform(sanitizeFileName),
    relativePath: z
      .string()
      .max(1024)
      .optional()
      .transform((value) => (value === undefined ? undefined : sanitizeRelativePath(value))),
    size: z.number().int().min(0).max(MAX_FILE_SIZE),
    mimeType: z.string().max(128),
    chunkSize: z.number().int().min(1024).max(64 * 1024),
    totalChunks: z.number().int().min(0),
  })
  .strict()
  .refine((meta) => meta.totalChunks === computeTotalChunks(meta.size, meta.chunkSize));

const bytesSchema = z.array(z.number().int().min(0).max(255));

export const controlMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      protocol: z.literal(PROTOCOL_VERSION),
      /** Self-declared device name; sanitized again by the receiver. */
      name: z.string().max(128).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('offer'),
      batchId: batchIdSchema,
      secure: z.boolean(),
      items: z.array(fileMetaSchema).min(1).max(MAX_OFFER_ITEMS),
    })
    .strict(),
  z
    .object({
      type: z.literal('offer-response'),
      batchId: batchIdSchema,
      decision: z.enum(['accepted', 'declined']),
      /** Indices into the offer's item list when accepting a subset. */
      items: z.array(z.number().int().min(0)).max(MAX_OFFER_ITEMS).optional(),
      /** True when the sender itself withdrew the offer before consent. */
      withdrawn: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('auth-challenge'),
      batchId: batchIdSchema,
      salt: bytesSchema,
      iterations: z.number().int().min(1000).max(1_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('auth-verify'),
      batchId: batchIdSchema,
      proof: bytesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('auth-result'),
      batchId: batchIdSchema,
      ok: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('auth-cancel'), batchId: batchIdSchema }).strict(),
  z
    .object({
      type: z.literal('file-start'),
      batchId: batchIdSchema,
      transferId: transferIdSchema,
      file: fileMetaSchema,
      offset: z.number().int().min(0),
    })
    .strict(),
  z.object({ type: z.literal('file-end'), transferId: transferIdSchema }).strict(),
  z.object({ type: z.literal('transfer-ack'), transferId: transferIdSchema }).strict(),
  z
    .object({
      type: z.literal('transfer-cancel'),
      transferId: transferIdSchema,
      reason: z.string().max(200).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('transfer-error'),
      transferId: transferIdSchema,
      message: z.string().max(300),
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      id: z.string().max(24),
      text: z.string().min(1).max(MAX_TEXT_LENGTH),
    })
    .strict(),
]);

export function computeTotalChunks(size: number, chunkSize: number): number {
  if (size <= 0) return 0;
  return Math.ceil(size / chunkSize);
}

/** Strips control characters and path separators from untrusted filenames. */
export function sanitizeFileName(name: string): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch === '\\' || ch === '/' ? '_' : ch;
  }
  const trimmed = out.trim();
  if (trimmed.length === 0 || trimmed === '.' || trimmed === '..') return 'droply-file';
  return trimmed.length > MAX_FILE_NAME_LENGTH ? trimmed.slice(0, MAX_FILE_NAME_LENGTH) : trimmed;
}

/**
 * Sanitizes a client-supplied folder path: splits on both separators, drops
 * dot segments, and re-joins with '/'. Guards against zip-slip-style
 * traversal if a path were ever used against a filesystem.
 */
export function sanitizeRelativePath(path: string): string | undefined {
  const parts = path
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.' && part !== '..');
  if (parts.length === 0) return undefined;
  return parts.slice(0, 32).map(sanitizeFileName).join('/');
}

export interface ParsedControl {
  ok: true;
  message: ControlMessage;
}

/** Parses one JSON control frame. Returns null when the frame is invalid. */
export function parseControlMessage(raw: string, maxBytes = MAX_OFFER_BYTES): ControlMessage | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > maxBytes) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = controlMessageSchema.safeParse(data);
  return result.success ? (result.data as ControlMessage) : null;
}

export function serializeControl(message: ControlMessage): string {
  return JSON.stringify(message);
}

/** Upper bound for the UTF-8 encoded offer frame itself. */
export function offerByteSize(message: Extract<ControlMessage, { type: 'offer' }>): number {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}

export { PROTOCOL_VERSION, TRANSFER_PROTOCOL };
