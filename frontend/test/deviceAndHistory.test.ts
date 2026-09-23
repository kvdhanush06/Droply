import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_DEVICE_NAME_LENGTH, loadDeviceName, sanitizeDeviceName, saveDeviceName } from '../src/utils/deviceName';
import {
  MAX_HISTORY_ENTRIES,
  appendHistory,
  clearHistory,
  loadHistory,
  type HistoryEntry,
} from '../src/services/history/transferHistory';

describe('sanitizeDeviceName', () => {
  it('trims whitespace and keeps normal names', () => {
    expect(sanitizeDeviceName('  Maya’s Laptop  ')).toBe('Maya’s Laptop');
  });

  it('strips control characters', () => {
    expect(sanitizeDeviceName('Evil\u0000Name\u2028Line')).toBe('EvilNameLine');
  });

  it('caps the length', () => {
    const long = 'x'.repeat(MAX_DEVICE_NAME_LENGTH + 50);
    expect(sanitizeDeviceName(long)).toHaveLength(MAX_DEVICE_NAME_LENGTH);
  });

  it('returns null for empty or control-only input', () => {
    expect(sanitizeDeviceName('')).toBeNull();
    expect(sanitizeDeviceName('   ')).toBeNull();
    expect(sanitizeDeviceName('\u0000\u0007')).toBeNull();
  });
});

describe('device name persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips through localStorage', () => {
    saveDeviceName('Work PC');
    expect(loadDeviceName()).toBe('Work PC');
  });

  it('returns null when nothing is stored', () => {
    expect(loadDeviceName()).toBeNull();
  });
});

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `t${Math.random().toString(36).slice(2)}:outgoing`,
    name: 'report.pdf',
    size: 2048,
    bytesTransferred: 2048,
    direction: 'sent',
    status: 'completed',
    senderName: 'My Laptop',
    receiverName: 'My Phone',
    secure: true,
    zipped: false,
    finishedAt: Date.now(),
    ...overrides,
  };
}

describe('transfer history', () => {
  beforeEach(() => localStorage.clear());

  it('appends entries newest-first and reloads them', () => {
    const first = makeEntry({ name: 'a.bin' });
    const second = makeEntry({ name: 'b.bin' });
    appendHistory(first);
    appendHistory(second);
    const loaded = loadHistory();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.name).toBe('b.bin');
    expect(loaded[1]!.name).toBe('a.bin');
    expect(loaded[0]!.senderName).toBe('My Laptop');
    expect(loaded[0]!.secure).toBe(true);
  });

  it('replaces an entry with the same id instead of duplicating it', () => {
    const entry = makeEntry({ id: 'same:outgoing' });
    appendHistory(entry);
    appendHistory({ ...entry, status: 'failed' });
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.status).toBe('failed');
  });

  it(`caps the stored history at ${MAX_HISTORY_ENTRIES} entries`, () => {
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 20; i += 1) appendHistory(makeEntry({ id: `t${i}:sent` }));
    expect(loadHistory()).toHaveLength(MAX_HISTORY_ENTRIES);
  });

  it('drops malformed entries when loading', () => {
    localStorage.setItem(
      'droply-transfer-history',
      JSON.stringify([makeEntry({ id: 'ok:sent' }), { bogus: true }, null, 'junk']),
    );
    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('ok:sent');
  });

  it('clears the history', () => {
    appendHistory(makeEntry());
    clearHistory();
    expect(loadHistory()).toHaveLength(0);
  });
});
