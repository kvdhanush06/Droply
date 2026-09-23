import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';

interface PasswordDialogProps {
  /** Number of files waiting for the password (shown for context). */
  fileCount: number;
  onConfirm: (password: string) => void;
  onCancel: () => void;
}

/**
 * Custom modal for choosing a transfer password — replaces the browser's
 * window.prompt so the flow looks and behaves consistently, supports Escape
 * and overlay dismissal, and keeps focus inside the dialog.
 */
export function PasswordDialog({ fileCount, onConfirm, onCancel }: PasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = password.trim();
    if (!value) {
      setError('Enter a password.');
      return;
    }
    if (value !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    onConfirm(value);
  };

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-dialog-heading"
      >
        <h2 id="password-dialog-heading" style={{ fontSize: '1.1rem' }}>
          <KeyRound size={16} aria-hidden style={{ verticalAlign: '-3px', marginRight: 6 }} />
          Password-protect this transfer
        </h2>
        <p className="hint" style={{ marginTop: 0 }}>
          The receiving device must enter the same password to unlock {fileCount === 1 ? 'the file' : `the ${fileCount} files`}.
          The password never leaves your devices.
        </p>
        <form onSubmit={submit} className="password-form">
          <label className="label" htmlFor="transfer-password">
            Password
          </label>
          <input
            id="transfer-password"
            ref={inputRef}
            type="password"
            className="input"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
          />
          <label className="label" htmlFor="transfer-password-confirm">
            Confirm password
          </label>
          <input
            id="transfer-password-confirm"
            type="password"
            className="input"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              if (error) setError(null);
            }}
          />
          {error && (
            <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
              {error}
            </p>
          )}
          <div className="share-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-outline" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!password.trim() || !confirm}>
              Protect &amp; send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
