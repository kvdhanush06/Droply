/**
 * Transfer history, persisted in this browser's localStorage so it survives
 * page refreshes. It never leaves the device: the server learns nothing about
 * it and no file contents are stored — only metadata (names, sizes, flags).
 */

export interface HistoryEntry {
  /** transferId + direction, unique per transfer on this device. */
  id: string;
  name: string;
  size: number;
  /** Bytes actually moved: sent for outgoing, received for incoming. */
  bytesTransferred: number;
  direction: 'sent' | 'received';
  status: 'completed' | 'failed' | 'cancelled';
  senderName: string | null;
  receiverName: string | null;
  /** Password-protected end to end. */
  secure: boolean;
  /** Sent as a zipped bundle. */
  zipped: boolean;
  finishedAt: number;
}

const STORAGE_KEY = 'droply-transfer-history';
/** History depth kept locally; names stay capped so a hostile sender can
 *  never bloat the storage (each entry ≤ ~2 KB, so ≤ ~1 MB total). */
export const MAX_HISTORY_ENTRIES = 200;
const MAX_NAME_LENGTH = 1024;

/** Fired on window after the stored history changes, so panels refresh live. */
export const HISTORY_CHANGED_EVENT = 'droply-history-changed';

function isValidEntry(raw: unknown): raw is HistoryEntry {
  if (typeof raw !== 'object' || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length <= 64 &&
    typeof e.name === 'string' &&
    e.name.length <= MAX_NAME_LENGTH &&
    typeof e.size === 'number' &&
    Number.isFinite(e.size) &&
    e.size >= 0 &&
    typeof e.bytesTransferred === 'number' &&
    Number.isFinite(e.bytesTransferred) &&
    e.bytesTransferred >= 0 &&
    (e.direction === 'sent' || e.direction === 'received') &&
    (e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled') &&
    (e.senderName === null || typeof e.senderName === 'string') &&
    (e.receiverName === null || typeof e.receiverName === 'string') &&
    typeof e.secure === 'boolean' &&
    typeof e.zipped === 'boolean' &&
    typeof e.finishedAt === 'number' &&
    Number.isFinite(e.finishedAt)
  );
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry).slice(0, MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

function persist(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* storage full or unavailable — history stays in memory only */
  }
  window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
}

/** Adds a finished transfer to the top of the history (newest first). */
export function appendHistory(entry: HistoryEntry): void {
  const entries = loadHistory().filter((e) => e.id !== entry.id);
  entries.unshift(entry);
  persist(entries.slice(0, MAX_HISTORY_ENTRIES));
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT));
}
