import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRightLeft, PlusCircle, LogIn, ShieldCheck, Zap, UserX, MonitorSmartphone } from 'lucide-react';
import { useRoomSession } from '../hooks/useRoomSession';
import { isWebRtcSupported } from '../config/env';
import { normalizeRoomCode } from '../utils/roomCode';
import { MAX_DEVICE_NAME_LENGTH, sanitizeDeviceName } from '../utils/deviceName';
import { HistoryPanel } from '../components/HistoryPanel';

export function HomePage() {
  const { session, snapshot } = useRoomSession();
  const navigate = useNavigate();
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState(false);
  const [nameDraft, setNameDraft] = useState(snapshot.deviceName ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const supported = isWebRtcSupported();
  const hasDeviceName = sanitizeDeviceName(nameDraft) !== null;

  // Once the room exists server-side, move into it.
  useEffect(() => {
    if (pendingCreate && snapshot.roomId) {
      navigate(`/room/${snapshot.roomId}`);
    }
  }, [pendingCreate, snapshot.roomId, navigate]);

  useEffect(() => {
    if (pendingCreate && snapshot.status === 'error') {
      setPendingCreate(false);
    }
  }, [pendingCreate, snapshot.status]);

  const saveDeviceName = (): boolean => {
    const name = sanitizeDeviceName(nameDraft);
    if (!name) {
      setNameError('Enter a name for this device first — it is shown to the devices you connect with.');
      return false;
    }
    setNameError(null);
    setNameDraft(name);
    return session.setDeviceName(name);
  };

  const createRoom = () => {
    if (!supported) return;
    if (!saveDeviceName()) return;
    setPendingCreate(true);
    session.createRoom();
  };

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    if (!saveDeviceName()) return;
    const code = normalizeRoomCode(joinCode);
    if (!code) {
      setJoinError('Enter the 8-character room code shown on the other device.');
      return;
    }
    setJoinError(null);
    navigate(`/room/${code}`);
  };

  return (
    <>
      {!supported && (
        <div className="card" role="alert" style={{ marginBottom: 'var(--space-5)', borderColor: 'var(--danger)' }}>
          <strong>This browser can’t run Droply.</strong>
          <p style={{ margin: '8px 0 0' }}>
            Droply needs WebRTC data channels, which are available in current versions of Chrome, Edge,
            Firefox and Safari. Please update or switch browsers.
          </p>
        </div>
      )}

      <section className="hero">
        <h1 className="hero-title">
          Send files. <span className="highlight">Directly</span> between your devices.
        </h1>
        <p className="hero-sub">
          Open Droply, create a room, scan the code with your other device — and drop files or text
          straight across. No uploads, no accounts, no cloud storage.
        </p>
        <div className="device-name-box">
          <label className="label" htmlFor="device-name">
            <MonitorSmartphone size={16} aria-hidden style={{ verticalAlign: '-3px', marginRight: 6 }} />
            This device’s name
          </label>
          <input
            id="device-name"
            className="input"
            placeholder="e.g. Maya’s Laptop"
            value={nameDraft}
            maxLength={MAX_DEVICE_NAME_LENGTH}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setNameDraft(e.target.value);
              if (nameError) setNameError(null);
              const name = sanitizeDeviceName(e.target.value);
              if (name) session.setDeviceName(name);
            }}
            onBlur={() => {
              if (sanitizeDeviceName(nameDraft)) saveDeviceName();
            }}
          />
          <p className="hint" style={{ marginTop: 'var(--space-2)' }}>
            Required before joining a room — it is shown to the other devices so everyone knows who is
            sending what.
          </p>
          {nameError && (
            <p role="alert" style={{ color: 'var(--danger)', margin: 'var(--space-2) 0 0' }}>
              {nameError}
            </p>
          )}
        </div>

        <div className="hero-actions">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={createRoom}
            disabled={!supported || !hasDeviceName || pendingCreate || snapshot.status === 'connecting'}
          >
            <PlusCircle size={20} aria-hidden />
            {pendingCreate ? 'Creating room…' : 'Create a room'}
          </button>
        </div>
        {pendingCreate && snapshot.status === 'error' && (
          <p role="alert" style={{ color: 'var(--danger)', marginTop: 'var(--space-3)' }}>
            {snapshot.errorMessage ?? 'Could not create a room. Please try again.'}
          </p>
        )}

        <form className="join-box" style={{ marginTop: 'var(--space-6)' }} onSubmit={submitJoin}>
          <label className="visually-hidden" htmlFor="join-code">
            Room code
          </label>
          <input
            id="join-code"
            className="input"
            placeholder="Enter the room code here"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={12}
          />
          <button type="submit" className="btn btn-outline" disabled={!supported || !hasDeviceName}>
            <LogIn size={16} aria-hidden /> Join
          </button>
        </form>
        {joinError && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {joinError}
          </p>
        )}

        <div className="trust-points">
          <span>
            <ArrowRightLeft aria-hidden /> Peer-to-peer, browser to browser
          </span>
          <span>
            <UserX aria-hidden /> No account needed
          </span>
          <span>
            <ShieldCheck aria-hidden /> Encrypted in transit (WebRTC DTLS)
          </span>
          <span>
            <Zap aria-hidden /> Nothing stored on a server
          </span>
        </div>
      </section>

      <HistoryPanel />
    </>
  );
}
