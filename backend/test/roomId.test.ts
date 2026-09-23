import { describe, expect, it } from 'vitest';
import { generateRoomId, normalizeRoomId, ROOM_ID_ALPHABET, ROOM_ID_LENGTH } from '../src/roomId.js';

describe('roomId generation', () => {
  it('generates codes in the XXXX-XXXX format', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = generateRoomId();
      expect(id).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('never uses ambiguous characters', () => {
    for (let i = 0; i < 500; i += 1) {
      const id = generateRoomId();
      expect(id).not.toMatch(/[IO01]/);
    }
  });

  it('produces unique ids across a large sample', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      ids.add(generateRoomId());
    }
    expect(ids.size).toBe(5000);
  });

  it('uses every alphabet character over enough samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      for (const ch of generateRoomId().replace('-', '')) seen.add(ch);
    }
    expect(seen.size).toBe(ROOM_ID_ALPHABET.length);
    expect(ROOM_ID_ALPHABET).toHaveLength(32);
  });
});

describe('normalizeRoomId', () => {
  it('accepts canonical codes', () => {
    expect(normalizeRoomId('K7QF-9X2A')).toBe('K7QF-9X2A');
  });

  it('normalizes case, dashes and whitespace', () => {
    expect(normalizeRoomId('k7qf9x2a')).toBe('K7QF-9X2A');
    expect(normalizeRoomId('K7QF 9X2A')).toBe('K7QF-9X2A');
    expect(normalizeRoomId('  K7QF-9X2A  ')).toBe('K7QF-9X2A');
  });

  it('rejects invalid input', () => {
    expect(normalizeRoomId('')).toBeNull();
    expect(normalizeRoomId('SHORT')).toBeNull();
    expect(normalizeRoomId('WAY-TOO-LONG-CODE')).toBeNull();
    expect(normalizeRoomId('K7QF-9X2!')).toBeNull();
    expect(normalizeRoomId('IIII-IIII')).toBeNull(); // ambiguous chars not in alphabet
    expect(normalizeRoomId('0000-0000')).toBeNull();
    expect(normalizeRoomId(12345678)).toBeNull();
    expect(normalizeRoomId(null)).toBeNull();
    expect(normalizeRoomId(undefined)).toBeNull();
    expect(normalizeRoomId({ roomId: 'K7QF-9X2A' })).toBeNull();
  });

  it('round-trips generated ids', () => {
    const id = generateRoomId();
    expect(normalizeRoomId(id)).toBe(id);
    expect(normalizeRoomId(id.toLowerCase().replace('-', ' '))).toBe(id);
  });

  it('has the expected code length', () => {
    expect(generateRoomId().replace('-', '')).toHaveLength(ROOM_ID_LENGTH);
  });
});
