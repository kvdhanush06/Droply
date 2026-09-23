import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Copy, Share2, Users, Wifi, WifiOff, Home, MonitorSmartphone, KeyRound, Archive } from 'lucide-react';
import { useRoomSession } from '../hooks/useRoomSession';
import { normalizeRoomCode } from '../utils/roomCode';
import { canShare, copyTextToClipboard, shareLink } from '../services/clipboard/clipboard';
import { useToast } from '../components/Toast';
import { StatusBadge } from '../components/StatusBadge';
import { QrCode } from '../components/QrCode';
import { DropZone } from '../components/DropZone';
import { TextPanel } from '../components/TextPanel';
import { TransferItemCard } from '../components/TransferItemCard';
import { OfferPanel } from '../components/OfferPanel';
import { PasswordPrompt } from '../components/PasswordPrompt';
import { PasswordDialog } from '../components/PasswordDialog';
import { HistoryPanel } from '../components/HistoryPanel';
import { shortPeerId } from '../utils/format';
import { MAX_DEVICE_NAME_LENGTH, sanitizeDeviceName } from '../utils/deviceName';
import { isZipSupported } from '../services/transfer/zip';

/** Device-name form for conflicts; prefilled with the clashing name. */
function NameConflictForm({ currentName, onSave }: { currentName: string; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState(currentName);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = sanitizeDeviceName(draft);
    if (!name) {
      setError('Enter a name for this device to join the room.');
      return;
    }
    if (name.toLowerCase() === currentName.trim().toLowerCase()) {
      setError('That name is the one already taken — please choose a different one.');
      return;
    }
    onSave(name);
  };

  return (
    <form onSubmit={submit} className="device-gate-form">
      <label className="label" htmlFor="conflict-device-name">
        This device’s name
      </label>
      <input
        id="conflict-device-name"
        className="input"
        value={draft}
        maxLength={MAX_DEVICE_NAME_LENGTH}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
      />
      {error && (
        <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={!sanitizeDeviceName(draft)}>
        Save name &amp; join the room
      </button>
    </form>
  );
}

/**
 * Confirmation screen shown on a room link before anything joins: the user
 * sees exactly which room they will enter and under which device name. The
 * join fires only when they press the button, so a name conflict surfaces
 * at that moment (with the rename form) instead of after a phantom
 * navigation or a refresh.
 */
function JoinInterstitial({
  roomId,
  deviceName,
  currentRoomId,
  onJoin,
  onLeaveAndJoin,
  onRename,
}: {
  roomId: string;
  deviceName: string;
  currentRoomId: string | null;
  onJoin: () => void;
  onLeaveAndJoin: () => void;
  onRename: (name: string) => void;
}) {
  const [changing, setChanging] = useState(false);
  const inAnotherRoom = currentRoomId !== null && currentRoomId !== roomId;

  return (
    <section className="card device-gate" aria-labelledby="join-interstitial-heading">
      <h1 id="join-interstitial-heading" style={{ fontSize: '1.3rem' }}>
        <MonitorSmartphone size={20} aria-hidden style={{ verticalAlign: '-3px', marginRight: 8 }} />
        Join room <span className="room-code">{roomId}</span>
      </h1>
      {inAnotherRoom ? (
        <p>
          This device is currently in room <strong>{currentRoomId}</strong>. Leave it to join room{' '}
          <strong>{roomId}</strong> instead.
        </p>
      ) : (
        <p>
          You are about to join this room as <strong>{deviceName}</strong>. Device names must be unique per room —
          if the name is already taken you can pick another before connecting.
        </p>
      )}
      {changing ? (
        <NameConflictForm currentName={deviceName} onSave={onRename} />
      ) : (
        <div className="share-row" style={{ justifyContent: 'flex-start' }}>
          {inAnotherRoom ? (
            <button type="button" className="btn btn-primary" onClick={onLeaveAndJoin}>
              Leave room {currentRoomId} &amp; join {roomId}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onJoin}>
              Join as {deviceName}
            </button>
          )}
          <button type="button" className="btn btn-outline" onClick={() => setChanging(true)}>
            Change name
          </button>
        </div>
      )}
    </section>
  );
}

/** Mandatory device-name gate shown before joining a room from a link. */
function DeviceNameGate({ onSave }: { onSave: (name: string) => void }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = sanitizeDeviceName(draft);
    if (!name) {
      setError('Enter a name for this device to join the room.');
      return;
    }
    onSave(name);
  };

  return (
    <section className="card device-gate" aria-labelledby="device-gate-heading">
      <h1 id="device-gate-heading" style={{ fontSize: '1.3rem' }}>
        <MonitorSmartphone size={20} aria-hidden style={{ verticalAlign: '-3px', marginRight: 8 }} />
        Name this device first
      </h1>
      <p>
        The other devices in the room will see this name next to everything you send and receive.
      </p>
      <form onSubmit={submit} className="device-gate-form">
        <label className="label" htmlFor="gate-device-name">
          This device’s name
        </label>
        <input
          id="gate-device-name"
          className="input"
          placeholder="e.g. Maya’s Phone"
          value={draft}
          maxLength={MAX_DEVICE_NAME_LENGTH}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
        />
        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={!sanitizeDeviceName(draft)}>
          Save &amp; join the room
        </button>
      </form>
    </section>
  );
}

export function RoomPage() {
  const { roomId: rawParam } = useParams<{ roomId: string }>();
  const roomId = rawParam ? normalizeRoomCode(rawParam) : null;
  const { session, snapshot } = useRoomSession();
  const navigate = useNavigate();
  const { notify } = useToast();
  const notifiedTransfers = useRef(new Set<string>());
  const lastErrorRef = useRef<string | null>(null);
  const [zipEnabled, setZipEnabled] = useState(false);
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [passwordFiles, setPasswordFiles] = useState<File[] | null>(null);
  /** Batches whose password is being verified right now (receiver side). */
  const [verifyingBatches, setVerifyingBatches] = useState<string[]>([]);

  // A room URL never auto-joins: the interstitial below confirms the room and
  // the device name first, so a name conflict surfaces the moment the user
  // commits to joining — never after a phantom navigation or a refresh.
  // Entering this page also clears a stale name-conflict from another room.
  useEffect(() => {
    if (snapshot.nameConflictError !== null) session.clearNameConflict();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Notify on completed / failed transfers (once per transfer).
  useEffect(() => {
    for (const t of snapshot.transfers) {
      const key = `${t.transferId}:${t.status}`;
      if (notifiedTransfers.current.has(key)) continue;
      if (t.status === 'completed' && t.direction === 'incoming') {
        notifiedTransfers.current.add(key);
        notify('success', `Received “${t.name}”.`);
      } else if (t.status === 'failed') {
        notifiedTransfers.current.add(key);
        notify('error', `Transfer of “${t.name}” failed.`);
      }
    }
  }, [snapshot.transfers, notify]);

  // Surface session-level problems instead of failing silently.
  useEffect(() => {
    const message = snapshot.errorMessage;
    if (!message || message === lastErrorRef.current) return;
    lastErrorRef.current = message;
    notify('error', message);
  }, [snapshot.errorMessage, notify]);

  // The “checking password” card clears as soon as the first file of the
  // unlocked batch arrives, when the prompt re-opens (wrong password), or —
  // as a bounded safety net for races like a sender withdrawal — after 45s.
  const verifyingSince = useRef(new Map<string, number>());
  const incomingCount = snapshot.transfers.filter((t) => t.direction === 'incoming').length;
  const incomingCountRef = useRef(incomingCount);
  useEffect(() => {
    const grew = incomingCount > incomingCountRef.current;
    incomingCountRef.current = incomingCount;
    if (grew && verifyingBatches.length > 0) {
      verifyingSince.current.clear();
      setVerifyingBatches([]);
    }
  }, [incomingCount, verifyingBatches.length]);
  useEffect(() => {
    if (verifyingBatches.length === 0) return;
    const reopened = verifyingBatches.filter((batchId) =>
      snapshot.passwordPrompts.some((prompt) => prompt.batchId === batchId),
    );
    const expired = verifyingBatches.filter(
      (batchId) => Date.now() - (verifyingSince.current.get(batchId) ?? 0) > 45_000,
    );
    const stale = [...reopened, ...expired];
    if (stale.length > 0) {
      setVerifyingBatches((prev) => prev.filter((batchId) => !stale.includes(batchId)));
      for (const batchId of stale) verifyingSince.current.delete(batchId);
    }
  }, [snapshot.passwordPrompts, verifyingBatches]);

  const roomUrl = useMemo(
    () => (snapshot.roomId ? `${window.location.origin}/room/${snapshot.roomId}` : ''),
    [snapshot.roomId],
  );

  if (!roomId) {
    return (
      <section className="card" role="alert">
        <h1>That room link doesn’t look right</h1>
        <p>The address should contain an 8-character room code, for example K7QF-9X2A.</p>
        <Link to="/" className="btn btn-primary">
          <Home size={16} aria-hidden /> Back to Droply
        </Link>
      </section>
    );
  }

  // Naming this device is mandatory before the session joins the room.
  if (!snapshot.deviceName) {
    return <DeviceNameGate onSave={(name) => session.setDeviceName(name)} />;
  }

  // Fresh arrival on a room URL (shared link / code entry): confirm the room
  // and the device name before any join request leaves this device.
  const inRoomFlow =
    snapshot.roomId === roomId || snapshot.nameConflictError !== null || snapshot.status !== 'idle';
  if (!inRoomFlow) {
    return (
      <JoinInterstitial
        roomId={roomId}
        deviceName={snapshot.deviceName}
        currentRoomId={snapshot.roomId}
        onJoin={() => session.joinRoom(roomId)}
        onLeaveAndJoin={() => session.joinRoom(roomId)}
        onRename={(name) => {
          session.setDeviceName(name);
          session.joinRoom(roomId);
        }}
      />
    );
  }

  // The server refused the join because another device in the room already
  // uses this name. Let the user pick a different one without leaving the page.
  if (snapshot.nameConflictError) {
    return (
      <section className="card device-gate" aria-labelledby="name-conflict-heading">
        <h1 id="name-conflict-heading" style={{ fontSize: '1.3rem' }}>
          <MonitorSmartphone size={20} aria-hidden style={{ verticalAlign: '-3px', marginRight: 8 }} />
          Name already in use
        </h1>
        <p role="alert" style={{ color: 'var(--danger)', margin: '0 0 var(--space-4)' }}>
          {snapshot.nameConflictError}
        </p>
        <NameConflictForm
          currentName={snapshot.deviceName}
          onSave={(name) => {
            session.setDeviceName(name);
            session.joinRoom(roomId);
          }}
        />
      </section>
    );
  }

  const copyLink = async () => {
    const ok = await copyTextToClipboard(roomUrl);
    notify(ok ? 'success' : 'error', ok ? 'Room link copied.' : 'Could not copy the link.');
  };

  const copyCode = async () => {
    if (!snapshot.roomId) return;
    const ok = await copyTextToClipboard(snapshot.roomId);
    notify(ok ? 'success' : 'error', ok ? 'Room code copied.' : 'Could not copy the code.');
  };

  const share = async () => {
    const shared = await shareLink('Join my Droply room', 'Send files directly between our devices.', roomUrl);
    if (!shared) await copyLink();
  };

  const ready = snapshot.status === 'ready';
  const showPairing = snapshot.status === 'waiting' || snapshot.status === 'connecting-peers' || ready;

  const onFiles = (files: File[]) => {
    if (passwordEnabled) {
      // Ask for the password in the custom dialog before anything is sent.
      setPasswordFiles(files);
      return;
    }
    void session.sendFiles(files, { zip: zipEnabled, zipLevel: 6, password: null });
  };

  const confirmPasswordSend = (password: string) => {
    const files = passwordFiles;
    setPasswordFiles(null);
    setPasswordEnabled(false);
    if (files && files.length > 0) {
      if (zipEnabled) notify('info', 'Preparing your archive — the transfer starts automatically.');
      void session.sendFiles(files, {
        zip: zipEnabled,
        zipLevel: 6,
        password,
      });
    }
  };

  return (
    <section aria-labelledby="room-heading">
      <div className="room-status-row">
        <div>
          <h1 id="room-heading" style={{ marginBottom: 4 }}>
            Room <span className="room-code">{snapshot.roomId ?? roomId}</span>
          </h1>
          <StatusBadge status={snapshot.status} />
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => {
            session.leaveRoom();
            navigate('/');
          }}
        >
          <Home size={14} aria-hidden /> Leave room
        </button>
      </div>

      {snapshot.status === 'error' && (
        <div className="card" role="alert" style={{ borderColor: 'var(--danger)', marginBottom: 'var(--space-5)' }}>
          <h2 style={{ fontSize: '1.1rem' }}>Something went wrong</h2>
          <p style={{ marginBottom: 'var(--space-3)' }}>{snapshot.errorMessage ?? 'The connection failed.'}</p>
          <div className="share-row" style={{ justifyContent: 'flex-start' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => session.joinRoom(roomId)}
            >
              Try again
            </button>
            <Link to="/" className="btn btn-outline btn-sm">
              Back home
            </Link>
          </div>
        </div>
      )}

      {snapshot.status === 'expired' && (
        <div className="card" role="alert" style={{ marginBottom: 'var(--space-5)' }}>
          <h2 style={{ fontSize: '1.1rem' }}>This room expired</h2>
          <p>Rooms disappear after a period of inactivity. Create a fresh room to keep sending.</p>
          <Link to="/" className="btn btn-primary btn-sm">
            Create a new room
          </Link>
        </div>
      )}

      <OfferPanel
        offers={snapshot.offers}
        onAcceptAll={(batchId) => session.acceptOffer(batchId)}
        onAcceptSelected={(batchId, selected) => session.acceptOfferItems(batchId, selected)}
        onDecline={(batchId) => session.declineOffer(batchId)}
      />

      <PasswordPrompt
        prompts={snapshot.passwordPrompts}
        onSubmit={(batchId, password) => {
          verifyingSince.current.set(batchId, Date.now());
          setVerifyingBatches((prev) => (prev.includes(batchId) ? prev : [...prev, batchId]));
          void session.submitOfferPassword(batchId, password).then((ok) => {
            if (!ok) {
              verifyingSince.current.delete(batchId);
              setVerifyingBatches((prev) => prev.filter((id) => id !== batchId));
              notify('error', 'Could not start the password check. Please check the transfer is still active and try again.');
            }
          });
        }}
        onCancel={(batchId) => {
          verifyingSince.current.delete(batchId);
          setVerifyingBatches((prev) => prev.filter((id) => id !== batchId));
          session.cancelOfferPassword(batchId);
        }}
      />

      {verifyingBatches.length > 0 && (
        <section className="card password-panel" aria-live="polite" data-testid="verifying-password">
          <h2>
            <KeyRound size={16} aria-hidden style={{ verticalAlign: '-3px', marginRight: 6 }} />
            Checking the password…
          </h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Verifying it securely with the sending device. This takes a few seconds — the transfer
            starts automatically afterwards.
          </p>
          <div className="progress" role="progressbar" aria-label="Checking password">
            <div className="progress-fill indeterminate" />
          </div>
        </section>
      )}

      {snapshot.zipProgress && (
        <section className="card password-panel" aria-live="polite" data-testid="zip-progress">
          <h2>
            <Archive size={16} aria-hidden style={{ verticalAlign: '-3px', marginRight: 6 }} />
            Preparing your files…
          </h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Compressing {snapshot.zipProgress.done} of {snapshot.zipProgress.total}{' '}
            {snapshot.zipProgress.total === 1 ? 'file' : 'files'} — the transfer starts automatically
            when the archive is ready. You can keep using the page meanwhile.
          </p>
          <div
            className="progress"
            role="progressbar"
            aria-label="Preparing archive"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((snapshot.zipProgress.done / Math.max(1, snapshot.zipProgress.total)) * 100)}
          >
            <div
              className="progress-fill"
              style={{
                width: `${Math.round((snapshot.zipProgress.done / Math.max(1, snapshot.zipProgress.total)) * 100)}%`,
              }}
            />
          </div>
        </section>
      )}

      {passwordFiles && (
        <PasswordDialog
          fileCount={passwordFiles.length}
          onConfirm={confirmPasswordSend}
          onCancel={() => setPasswordFiles(null)}
        />
      )}

      <div className="room-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <DropZone
            disabled={!ready}
            onFiles={onFiles}
            zipAvailable={isZipSupported()}
            zipEnabled={zipEnabled}
            onToggleZip={setZipEnabled}
            passwordEnabled={passwordEnabled}
            onTogglePassword={setPasswordEnabled}
          />

          {snapshot.transfers.length > 0 && (
            <section aria-label="Transfers">
              <h2 style={{ fontSize: '1.05rem' }}>Transfers</h2>
              <ul className="transfer-list">
                {snapshot.transfers.map((item) => (
                  <TransferItemCard
                    key={item.transferId}
                    item={item}
                    stats={session.statsFor(item.transferId)}
                    onCancel={(id) => session.cancelTransfer(id)}
                    onPause={(id) => session.pauseTransfer(id)}
                    onResume={(id) => session.resumeTransfer(id)}
                  />
                ))}
              </ul>
            </section>
          )}

          <TextPanel
            disabled={!ready}
            conversation={snapshot.conversation}
            onSend={(text) => session.sendText(text)}
          />
        </div>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          {showPairing && snapshot.roomId && (
            <section className="card qr-panel" aria-labelledby="pair-heading">
              <h2 id="pair-heading" style={{ fontSize: '1.05rem', marginBottom: 0 }}>
                Add a device
              </h2>
              <QrCode value={roomUrl} fallbackText={snapshot.roomId} />
              <p className="hint" style={{ margin: 0 }}>
                Scan with another device, or share the code:
              </p>
              <p className="room-code" style={{ margin: 0 }}>
                {snapshot.roomId}
              </p>
              <div className="share-row">
                <button type="button" className="btn btn-sm btn-outline" onClick={() => void copyLink()}>
                  <Copy size={14} aria-hidden /> Copy link
                </button>
                <button type="button" className="btn btn-sm btn-outline" onClick={() => void copyCode()}>
                  <Copy size={14} aria-hidden /> Copy code
                </button>
                {canShare() && (
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => void share()}>
                    <Share2 size={14} aria-hidden /> Share
                  </button>
                )}
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="devices-heading">
            <h2 id="devices-heading" style={{ fontSize: '1.05rem' }}>
              <Users size={16} aria-hidden style={{ verticalAlign: '-3px', marginRight: 6 }} />
              Devices in this room
            </h2>
            <ul className="peer-list">
              <li className="peer-row peer-self">
                <Wifi size={16} aria-hidden color="var(--success)" />
                <span>{snapshot.deviceName}</span>
                <span className="hint" style={{ margin: 0 }}>
                  this device
                </span>
              </li>
              {snapshot.peers.map((peer) => (
                <li key={peer.peerId} className="peer-row">
                  {peer.state === 'connected' ? (
                    <Wifi size={16} aria-hidden color="var(--success)" />
                  ) : (
                    <WifiOff size={16} aria-hidden color="var(--warning)" />
                  )}
                  <span>{peer.name ?? `Device ${shortPeerId(peer.peerId)}`}</span>
                  <span className="hint" style={{ margin: 0 }}>
                    {peer.state === 'connected' ? 'connected' : peer.state}
                  </span>
                </li>
              ))}
            </ul>
            {snapshot.peers.length === 0 && (
              <p className="hint">
                Only this device is here. Open the room link on another device to connect.
              </p>
            )}
          </section>

          <HistoryPanel />
        </aside>
      </div>
    </section>
  );
}
