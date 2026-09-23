import { useState } from 'react';
import { CheckCircle2, FolderUp, ShieldCheck, XCircle } from 'lucide-react';
import type { OfferEntry } from '../types';
import { formatBytes } from '../utils/format';

interface OfferPanelProps {
  offers: OfferEntry[];
  onAcceptAll: (batchId: string) => void;
  onAcceptSelected: (batchId: string, selected: number[]) => void;
  onDecline: (batchId: string) => void;
}

/**
 * Receiver consent UI: every incoming batch waits here until the user
 * accepts everything, accepts selected items, or declines. Nothing is
 * written to memory before acceptance.
 */
export function OfferPanel({ offers, onAcceptAll, onAcceptSelected, onDecline }: OfferPanelProps) {
  const [selectedByBatch, setSelectedByBatch] = useState<Map<string, Set<number>>>(new Map());

  if (offers.length === 0) return null;

  const toggle = (batchId: string, index: number, total: number) => {
    setSelectedByBatch((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(batchId) ?? Array.from({ length: total }, (_, i) => i));
      if (current.has(index)) {
        current.delete(index);
      } else {
        current.add(index);
      }
      next.set(batchId, current);
      return next;
    });
  };

  return (
    <section className="card offer-panel" aria-label="Incoming transfer requests">
      <h2>
        <ShieldCheck size={16} aria-hidden style={{ verticalAlign: '-3px', marginRight: 6 }} />
        Incoming transfer requests
      </h2>
      {offers.map((offer) => {
        const selected = selectedByBatch.get(offer.batchId) ?? new Set(offer.items.map((_, i) => i));
        const sender = offer.senderName ?? 'A device';
        return (
          <div key={offer.batchId} className="offer" data-testid={`offer-${offer.batchId}`}>
            <p className="offer-intro">
              {offer.secure
                ? `${sender} wants to send you password-protected files:`
                : `${sender} wants to send you:`}
            </p>
            <ul className="offer-items">
              {offer.items.map((item, index) => (
                <li key={`${item.name}-${index}`} className="offer-item">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(index)}
                      onChange={() => toggle(offer.batchId, index, offer.items.length)}
                    />
                    <span className="offer-item-name" title={item.relativePath ?? item.name}>
                      {item.relativePath ?? item.name}
                    </span>
                    <span className="offer-item-size">{formatBytes(item.size)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="share-row" style={{ justifyContent: 'flex-start' }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => onAcceptAll(offer.batchId)}
                disabled={selected.size === 0}
              >
                <CheckCircle2 size={14} aria-hidden /> Accept all
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline"
                onClick={() => onAcceptSelected(offer.batchId, [...selected])}
                disabled={selected.size === 0}
              >
                Accept selected ({selected.size})
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => onDecline(offer.batchId)}>
                <XCircle size={14} aria-hidden /> Decline
              </button>
            </div>
            {offer.secure && (
              <p className="hint">
                <FolderUp size={12} aria-hidden style={{ verticalAlign: '-2px', marginRight: 4 }} />
                This transfer is password-protected. You will be asked for the password after accepting.
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
