import { randomInt } from 'node:crypto';

/**
 * Room codes are 8 characters drawn from a 32-symbol alphabet that excludes
 * visually ambiguous characters (I, O, 0, 1). 32^8 ~= 2^40 possibilities,
 * which makes guessing or enumerating rooms impractical while keeping codes
 * short enough to read aloud or type.
 */
export const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_ID_LENGTH = 8;

/** Returns a fresh room id in the display format "XXXX-XXXX". */
export function generateRoomId(rand: (max: number) => number = (max) => randomInt(0, max)): string {
  let raw = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i += 1) {
    raw += ROOM_ID_ALPHABET[rand(ROOM_ID_ALPHABET.length)];
  }
  return formatRoomId(raw);
}

/** Formats a raw 8-character code as "XXXX-XXXX". */
export function formatRoomId(raw: string): string {
  return `${raw.slice(0, ROOM_ID_LENGTH / 2)}-${raw.slice(ROOM_ID_LENGTH / 2)}`;
}

/**
 * Normalizes user-supplied room codes: trims, upper-cases, removes dashes and
 * whitespace, and validates length + alphabet. Returns the canonical
 * "XXXX-XXXX" form, or null when the input is not a plausible room code.
 */
export function normalizeRoomId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().toUpperCase().replace(/[-\s]/g, '');
  if (cleaned.length !== ROOM_ID_LENGTH) return null;
  for (const ch of cleaned) {
    if (!ROOM_ID_ALPHABET.includes(ch)) return null;
  }
  return formatRoomId(cleaned);
}
