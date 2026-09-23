import { useCallback, useEffect, useState } from 'react';
import { FileDown, FileUp, History, Lock, Trash2, Archive } from 'lucide-react';
import {
  clearHistory,
  loadHistory,
  HISTORY_CHANGED_EVENT,
  type HistoryEntry,
} from '../services/history/transferHistory';
import { formatBytes } from '../utils/format';

const STATUS_LABEL: Record<HistoryEntry['status'], string> = {
  completed: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function statusClass(status: HistoryEntry['status']): string {
  switch (status) {
    case 'completed':
      return 'badge badge-success';
    case 'failed':
      return 'badge badge-danger';
    case 'cancelled':
      return 'badge badge-warning';
  }
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return '';
  }
}

/**
 * Local transfer history. Stored only in this browser (localStorage) so it
 * survives refreshes; it never touches the server and holds metadata only.
 */
export function HistoryPanel() {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory());

  const refresh = useCallback(() => setEntries(loadHistory()), []);

  useEffect(() => {
    window.addEventListener(HISTORY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(HISTORY_CHANGED_EVENT, refresh);
  }, [refresh]);

  if (entries.length === 0) return null;

  return (
    <section className="card history-panel" aria-labelledby="history-heading">
      <div className="history-head">
        <h2 id="history-heading" style={{ fontSize: '1.05rem', margin: 0 }}>
          <History size={16} aria-hidden style={{ verticalAlign: '-3px', marginRight: 6 }} />
          Transfer history
        </h2>
        <button type="button" className="btn btn-sm btn-outline" onClick={() => clearHistory()}>
          <Trash2 size={14} aria-hidden /> Clear history
        </button>
      </div>
      <p className="hint" style={{ marginTop: 'var(--space-1)' }}>
        {entries.length} {entries.length === 1 ? 'transfer' : 'transfers'} · kept only in this browser — the server never
        sees it. Scroll the list to see everything.
      </p>
      <ul className="history-list">
        {entries.map((entry) => {
          const Icon = entry.direction === 'sent' ? FileUp : FileDown;
          const from = entry.senderName ?? 'Unknown device';
          const to = entry.receiverName ?? 'Unknown device';
          return (
            <li key={entry.id} className="history-item">
              <div className="transfer-icon" aria-hidden>
                <Icon size={18} />
              </div>
              <div className="history-body">
                <div className="transfer-name" title={entry.name}>
                  {entry.name}
                </div>
                <div className="transfer-meta">
                  <span>{entry.direction === 'sent' ? 'Sent' : 'Received'}</span>
                  <span>
                    {formatBytes(entry.bytesTransferred)} of {formatBytes(entry.size)}
                  </span>
                  <span>
                    {from} → {to}
                  </span>
                  <span>{formatTime(entry.finishedAt)}</span>
                  <span className={statusClass(entry.status)}>{STATUS_LABEL[entry.status]}</span>
                  {entry.secure && (
                    <span className="badge badge-info">
                      <Lock size={11} aria-hidden /> Protected
                    </span>
                  )}
                  {entry.zipped && (
                    <span className="badge badge-neutral">
                      <Archive size={11} aria-hidden /> Zipped
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
