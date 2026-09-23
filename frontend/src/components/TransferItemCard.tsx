import { Download, FileDown, FileUp, Lock, Archive, Pause, Play, X } from 'lucide-react';
import type { TransferItem } from '../types';
import { formatBytes, formatDuration, formatPercent, formatSpeed } from '../utils/format';
import { useEffect, useState } from 'react';

interface Props {
  item: TransferItem;
  stats: { bytesPerSecond: number; etaSeconds: number | null };
  onCancel: (transferId: string) => void;
  onPause?: (transferId: string) => void;
  onResume?: (transferId: string) => void;
}

function statusLabel(item: TransferItem): string {
  switch (item.status) {
    case 'queued':
      return item.paused ? 'Paused' : 'Waiting';
    case 'active':
      return item.direction === 'incoming' ? 'Receiving' : 'Sending';
    case 'completed':
      return 'Complete';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
  }
}

/**
 * Human label for a transfer row: folder paths collapse to "Folder", known
 * types show a short kind ("ZIP archive", "PDF document"), and unknown or
 * generic types never leak raw MIME strings like "application/octet-stream".
 */
export function formatKind(name: string, mimeType: string): string {
  if (name.includes('/')) return 'Folder item';
  if (mimeType === 'application/zip' || name.toLowerCase().endsWith('.zip')) return 'ZIP archive';
  if (mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) return 'PDF document';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType === 'text/plain') return 'Text file';
  if (mimeType === 'application/json' || name.toLowerCase().endsWith('.json')) return 'JSON file';
  if (
    mimeType === 'application/octet-stream' ||
    mimeType === '' ||
    mimeType.startsWith('application/')
  ) {
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) {
      const ext = name.slice(dot + 1).toUpperCase();
      if (ext.length <= 5) return `${ext} file`;
    }
    return 'File';
  }
  return 'File';
}

function statusBadgeClass(status: TransferItem['status']): string {
  switch (status) {
    case 'completed':
      return 'badge badge-success';
    case 'active':
      return 'badge badge-info badge-live';
    case 'queued':
      return 'badge badge-neutral';
    case 'cancelled':
      return 'badge badge-warning';
    case 'failed':
      return 'badge badge-danger';
  }
}

/** Periodically re-render so speed/ETA labels stay fresh during a transfer. */
function useTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(timer);
  }, [active]);
}

export function TransferItemCard({ item, stats, onCancel, onPause, onResume }: Props) {
  useTick(item.status === 'active');
  const percent = formatPercent(item.bytesTransferred, item.size);
  const isActive = item.status === 'active' || item.status === 'queued';
  const Icon = item.direction === 'outgoing' ? FileUp : FileDown;
  const peerLabel = item.peerName ?? 'the other device';

  return (
    <li
      className="transfer-item"
      data-testid={`transfer-${item.transferId}`}
      data-direction={item.direction}
      data-active={item.status === 'active' ? 'true' : 'false'}
    >
      <div className="transfer-icon" aria-hidden>
        <Icon size={20} />
      </div>
      <div>
        <div className="transfer-name" title={item.name}>
          {item.name}
        </div>
        <div className="transfer-meta">
          <span>{item.direction === 'outgoing' ? `To ${peerLabel}` : `From ${peerLabel}`}</span>
          <span>{formatBytes(item.size)}</span>
          <span>{formatKind(item.name, item.mimeType)}</span>
          <span className={statusBadgeClass(item.status)}>
            {item.status === 'active' && <span className="dot" aria-hidden />}
            {statusLabel(item)}
          </span>
          {item.secure && (
            <span className="badge badge-info">
              <Lock size={11} aria-hidden /> Protected
            </span>
          )}
          {item.zipped && (
            <span className="badge badge-neutral">
              <Archive size={11} aria-hidden /> Zipped
            </span>
          )}
        </div>
        {item.status === 'queued' && item.error && <div className="transfer-stats">{item.error}</div>}
        {item.status === 'active' && (
          <>
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={Math.round((item.bytesTransferred / Math.max(1, item.size)) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${item.direction === 'incoming' ? 'Receiving' : 'Sending'} ${item.name}`}
            >
              <div
                className="progress-fill"
                style={{ width: percent }}
              />
            </div>
            <div className="transfer-stats">
              <strong>
                {item.direction === 'incoming' ? 'Receiving' : 'Sending'} — {percent}
              </strong>{' '}
              · {formatBytes(item.bytesTransferred)} / {formatBytes(item.size)} · {formatSpeed(stats.bytesPerSecond)}
              {stats.etaSeconds !== null && ` · ${formatDuration(stats.etaSeconds)} left`}
            </div>
          </>
        )}
        {item.status === 'failed' && item.error && <div className="transfer-stats">{item.error}</div>}
        {item.status === 'completed' && item.direction === 'outgoing' && (
          <div className="transfer-stats">Sent · {formatBytes(item.size)}</div>
        )}
        {item.status === 'completed' && item.direction === 'incoming' && (
          <div className="transfer-stats">Received · {formatBytes(item.bytesTransferred)}</div>
        )}
      </div>
      <div className="transfer-actions">
        {item.direction === 'outgoing' && item.status === 'active' && onPause && (
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => onPause(item.transferId)}
            aria-label={`Pause transfer of ${item.name}`}
          >
            <Pause size={14} aria-hidden /> Pause
          </button>
        )}
        {item.direction === 'outgoing' && item.status === 'queued' && item.paused && onResume && (
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => onResume(item.transferId)}
            aria-label={`Resume transfer of ${item.name}`}
          >
            <Play size={14} aria-hidden /> Resume
          </button>
        )}
        {isActive && (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => onCancel(item.transferId)}
            aria-label={`Cancel transfer of ${item.name}`}
          >
            <X size={14} aria-hidden /> Cancel
          </button>
        )}
        {item.status === 'completed' && item.direction === 'incoming' && item.downloadUrl && (
          <a
            className="btn btn-sm btn-primary"
            href={item.downloadUrl}
            download={item.name}
            aria-label={`Download ${item.name}`}
          >
            <Download size={14} aria-hidden /> Save
          </a>
        )}
      </div>
    </li>
  );
}
