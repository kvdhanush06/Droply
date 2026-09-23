/** Client-side room code handling; mirrors the backend alphabet and format. */

const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/**
 * Normalizes a typed/pasted room code (case, dashes and whitespace
 * insensitive). Returns the canonical "XXXX-XXXX" form or null.
 */
export function normalizeRoomCode(input: string): string | null {
  const cleaned = input.trim().toUpperCase().replace(/[-\s]/g, '');
  if (cleaned.length !== 8) return null;
  const formatted = `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
  return ROOM_CODE_PATTERN.test(formatted) ? formatted : null;
}
