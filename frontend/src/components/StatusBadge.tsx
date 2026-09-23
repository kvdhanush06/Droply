import type { RoomStatus } from '../types';

const STATUS_META: Record<RoomStatus, { label: string; className: string; live: boolean }> = {
  idle: { label: 'Idle', className: 'badge badge-neutral', live: false },
  connecting: { label: 'Connecting…', className: 'badge badge-info badge-live', live: true },
  waiting: { label: 'Waiting for a device…', className: 'badge badge-warning badge-live', live: true },
  'connecting-peers': { label: 'Establishing secure link…', className: 'badge badge-info badge-live', live: true },
  reconnecting: { label: 'Reconnecting…', className: 'badge badge-warning badge-live', live: true },
  ready: { label: 'Connected', className: 'badge badge-success', live: true },
  expired: { label: 'Room expired', className: 'badge badge-warning', live: false },
  error: { label: 'Connection problem', className: 'badge badge-danger', live: false },
};

/** Room status pill with a non-color text label (accessible by default). */
export function StatusBadge({ status }: { status: RoomStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={meta.className} role="status" aria-live="polite">
      {meta.live && <span className="dot" aria-hidden />}
      {meta.label}
    </span>
  );
}
