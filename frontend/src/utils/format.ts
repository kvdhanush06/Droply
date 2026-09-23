/** Formatting helpers for sizes, durations and identifiers. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : decimals)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.ceil(totalSeconds);
  if (seconds < 60) return `~${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `~${minutes} min ${rest} s`;
  const hours = Math.floor(minutes / 60);
  return `~${hours} h ${minutes % 60} min`;
}

export function formatPercent(done: number, total: number): string {
  if (total <= 0 || done >= total) return '100%';
  const pct = Math.min(100, Math.max(0, (done / total) * 100));
  // Never display "100%" while bytes are still outstanding.
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.min(99, Math.round(pct))}%`;
}

/** Short, human-friendly label for a peer id: "k7QF…9x2a" */
export function shortPeerId(peerId: string): string {
  if (peerId.length <= 10) return peerId;
  return `${peerId.slice(0, 4)}…${peerId.slice(-4)}`;
}
