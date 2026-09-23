import { useEffect, useRef, useState } from 'react';
import { Send, Copy } from 'lucide-react';
import type { ConversationEntry } from '../types';
import { MAX_TEXT_LENGTH } from '../services/transfer/protocol';
import { copyTextToClipboard } from '../services/clipboard/clipboard';
import { useToast } from './Toast';

interface Props {
  disabled: boolean;
  conversation: ConversationEntry[];
  onSend: (text: string) => boolean;
}

/** Keeps its own scroll position: re-rendering the whole panel on every keystroke (a state change) must not reset the history scroll. */
function ConversationList({
  conversation,
  onCopy,
}: {
  conversation: ConversationEntry[];
  onCopy: (text: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.length]);

  return (
    <div className="conversation" ref={listRef} data-testid="conversation" aria-label="Shared text history">
      {conversation.map((entry) => (
        <div key={`${entry.id}-${entry.receivedAt}`} className={`message ${entry.direction}`}>
          <span className="message-text">{entry.text}</span>
          <button
            type="button"
            className="message-copy"
            onClick={() => onCopy(entry.text)}
            aria-label="Copy this message to clipboard"
            title="Copy this message"
          >
            <Copy size={13} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Text panel: send typed text to connected devices. */
export function TextPanel({ disabled, conversation, onSend }: Props) {
  const [draft, setDraft] = useState('');
  const { notify } = useToast();

  const send = () => {
    const text = draft.trimEnd();
    if (text.length === 0 || disabled) return;
    if (onSend(text)) {
      setDraft('');
    } else {
      notify('error', 'No device is connected yet.');
    }
  };

  const copyEntry = async (text: string) => {
    const ok = await copyTextToClipboard(text);
    notify(ok ? 'success' : 'error', ok ? 'Copied to clipboard.' : 'Could not copy to clipboard.');
  };

  const onCopy = (text: string) => {
    void copyEntry(text);
  };

  return (
    <section className="card" aria-labelledby="text-panel-heading">
      <h2 id="text-panel-heading">Send text</h2>

      {conversation.length > 0 && <ConversationList conversation={conversation} onCopy={onCopy} />}

      <label className="label" htmlFor="text-draft">
        Write something to send…
      </label>
      <textarea
        id="text-draft"
        className="textarea"
        value={draft}
        maxLength={MAX_TEXT_LENGTH}
        placeholder="Paste a link, a note, a snippet — anything text."
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
      />
      <p className="hint" aria-live="polite">
        {(MAX_TEXT_LENGTH - draft.length).toLocaleString()} characters remaining
      </p>

      <div className="share-row" style={{ justifyContent: 'flex-start' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={send}
          disabled={disabled || draft.trim().length === 0}
        >
          <Send size={16} aria-hidden /> Send text
        </button>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => void copyEntry(draft)}
          disabled={draft.length === 0}
        >
          <Copy size={16} aria-hidden /> Copy draft
        </button>
      </div>
    </section>
  );
}
