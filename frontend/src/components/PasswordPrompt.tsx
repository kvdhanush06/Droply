import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { PasswordPromptEntry } from '../types';

interface PasswordPromptProps {
  prompts: PasswordPromptEntry[];
  onSubmit: (batchId: string, password: string) => void;
  onCancel: (batchId: string) => void;
}

/** Password gate shown on the receiving device for protected batches. */
export function PasswordPrompt({ prompts, onSubmit, onCancel }: PasswordPromptProps) {
  const [values, setValues] = useState<Record<string, string>>({});

  if (prompts.length === 0) return null;

  return (
    <section className="card password-panel" aria-label="Passwords required">
      <h2>
        <KeyRound size={16} aria-hidden style={{ verticalAlign: '-3px', marginRight: 6 }} />
        Password required
      </h2>
      {prompts.map((prompt) => (
        <form
          key={prompt.batchId}
          className="password-form"
          onSubmit={(event) => {
            event.preventDefault();
            const value = values[prompt.batchId]?.trim();
            if (value) {
              setValues((prev) => ({ ...prev, [prompt.batchId]: '' }));
              onSubmit(prompt.batchId, value);
            }
          }}
        >
          <label className="label" htmlFor={`pw-${prompt.batchId}`}>
            {prompt.senderName ?? 'The sending device'} protects this transfer with a password — enter it to
            receive the files:
          </label>
          {prompt.error && (
            <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
              {prompt.error}
            </p>
          )}
          <input
            id={`pw-${prompt.batchId}`}
            type="password"
            className="input"
            autoComplete="off"
            value={values[prompt.batchId] ?? ''}
            onChange={(e) => setValues((prev) => ({ ...prev, [prompt.batchId]: e.target.value }))}
            autoFocus
          />
          <div className="share-row" style={{ justifyContent: 'flex-start' }}>
            <button type="submit" className="btn btn-sm btn-primary" disabled={!values[prompt.batchId]?.trim()}>
              Unlock transfer
            </button>
            <button type="button" className="btn btn-sm btn-outline" onClick={() => onCancel(prompt.batchId)}>
              Decline transfer
            </button>
          </div>
        </form>
      ))}
    </section>
  );
}
