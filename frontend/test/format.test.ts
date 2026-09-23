import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatPercent, formatSpeed, shortPeerId } from '../src/utils/format';
import { normalizeRoomCode } from '../src/utils/roomCode';

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
  });

  it('handles invalid input', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(Infinity)).toBe('0 B');
  });
});

describe('formatSpeed', () => {
  it('appends /s and handles zero', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(1024 * 1024 * 42.3)).toBe('42.3 MB/s');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(7)).toBe('~7 s');
    expect(formatDuration(90)).toBe('~1 min 30 s');
    expect(formatDuration(3700)).toBe('~1 h 1 min');
  });

  it('handles unknown values', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('computes and clamps', () => {
    expect(formatPercent(50, 100)).toBe('50%');
    expect(formatPercent(870, 1000)).toBe('87%');
    expect(formatPercent(999, 1000)).toBe('99%'); // never shows 100% while incomplete
    expect(formatPercent(120, 100)).toBe('100%');
    expect(formatPercent(1, 0)).toBe('100%');
  });
});

describe('shortPeerId', () => {
  it('abbreviates long ids', () => {
    expect(shortPeerId('AbCdEfGh1234')).toBe('AbCd…1234');
    expect(shortPeerId('short')).toBe('short');
  });
});

describe('normalizeRoomCode', () => {
  it('accepts and normalizes codes', () => {
    expect(normalizeRoomCode('K7QF-9X2A')).toBe('K7QF-9X2A');
    expect(normalizeRoomCode('k7qf9x2a')).toBe('K7QF-9X2A');
    expect(normalizeRoomCode(' k7qf 9x2a ')).toBe('K7QF-9X2A');
  });

  it('rejects bad codes', () => {
    expect(normalizeRoomCode('')).toBeNull();
    expect(normalizeRoomCode('IO01-2345')).toBeNull();
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode('K7QF-9X2A-EXTRA')).toBeNull();
  });
});
