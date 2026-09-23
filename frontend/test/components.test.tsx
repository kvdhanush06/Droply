import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast';
import { DropZone } from '../src/components/DropZone';
import { TransferItemCard } from '../src/components/TransferItemCard';
import { TextPanel } from '../src/components/TextPanel';
import { StatusBadge } from '../src/components/StatusBadge';
import { NotFoundPage } from '../src/pages/StaticPages';
import type { TransferItem } from '../src/types';

function wrap(node: React.ReactElement) {
  return render(
    <MemoryRouter>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>,
  );
}

describe('DropZone', () => {
  it('is keyboard accessible and opens the picker affordance', () => {
    wrap(
      <DropZone disabled={false} onFiles={() => undefined} zipEnabled={false} passwordEnabled={false} />,
    );
    const zone = screen.getByRole('button', { name: /drop files/i });
    expect(zone).toHaveAttribute('tabindex', '0');
  });

  it('shows a disabled state before any device connects', () => {
    wrap(
      <DropZone disabled={true} onFiles={() => undefined} zipEnabled={false} passwordEnabled={false} />,
    );
    const zone = screen.getByRole('button', { name: /connect a device first/i });
    expect(zone).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/waiting for another device/i)).toBeInTheDocument();
  });

  it('shows zip and password toggles when available', () => {
    wrap(
      <DropZone
        disabled={false}
        onFiles={() => undefined}
        zipAvailable
        zipEnabled={false}
        onToggleZip={() => undefined}
        passwordEnabled={false}
        onTogglePassword={() => undefined}
      />,
    );
    expect(screen.getByText(/zip before sending/i)).toBeInTheDocument();
    expect(screen.getByText(/password-protect/i)).toBeInTheDocument();
  });
});

describe('TransferItemCard', () => {
  const base: TransferItem = {
    transferId: 't1',
    peerId: 'peer1',
    peerName: 'Test Phone',
    direction: 'incoming',
    name: 'photo.zip',
    size: 1024 * 1024,
    mimeType: 'application/zip',
    status: 'active',
    bytesTransferred: 512 * 1024,
    error: null,
    paused: false,
    secure: false,
    zipped: false,
    downloadUrl: null,
  };

  it('shows progress with an accessible progressbar', () => {
    wrap(<TransferItemCard item={base} stats={{ bytesPerSecond: 1024 * 100, etaSeconds: 5 }} onCancel={() => undefined} />);
    expect(screen.getByText('photo.zip')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    const stats = screen.getByText(
      (_, el) => el?.classList.contains('transfer-stats') === true && /KB\/s/.test(el.textContent ?? ''),
    );
    expect(stats.textContent).toContain('100 KB/s');
  });

  it('offers cancel for active transfers and invokes the callback', async () => {
    const onCancel = vi.fn();
    wrap(<TransferItemCard item={base} stats={{ bytesPerSecond: 0, etaSeconds: null }} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel transfer of photo\.zip/i }));
    expect(onCancel).toHaveBeenCalledWith('t1');
  });

  it('offers a download link for completed incoming transfers', () => {
    const done: TransferItem = { ...base, status: 'completed', downloadUrl: 'blob:fake' };
    wrap(<TransferItemCard item={done} stats={{ bytesPerSecond: 0, etaSeconds: null }} onCancel={() => undefined} />);
    const link = screen.getByRole('link', { name: /download photo\.zip/i });
    expect(link).toHaveAttribute('href', 'blob:fake');
    expect(link).toHaveAttribute('download', 'photo.zip');
  });

  it('shows failure messages', () => {
    const failed: TransferItem = { ...base, status: 'failed', error: 'The file did not arrive completely.' };
    wrap(<TransferItemCard item={failed} stats={{ bytesPerSecond: 0, etaSeconds: null }} onCancel={() => undefined} />);
    expect(screen.getByText('The file did not arrive completely.')).toBeInTheDocument();
  });
});

describe('TextPanel', () => {
  it('sends typed text and clears the draft', async () => {
    const onSend = vi.fn().mockReturnValue(true);
    wrap(<TextPanel disabled={false} conversation={[]} onSend={onSend} />);
    await userEvent.type(screen.getByLabelText(/write something to send/i), 'hello there');
    await userEvent.click(screen.getByRole('button', { name: /send text/i }));
    expect(onSend).toHaveBeenCalledWith('hello there');
    expect(screen.getByLabelText(/write something to send/i)).toHaveValue('');
  });

  it('disables sending when no device is connected', () => {
    wrap(<TextPanel disabled={true} conversation={[]} onSend={() => true} />);
    expect(screen.getByRole('button', { name: /send text/i })).toBeDisabled();
  });

  it('renders conversation entries with copy buttons', () => {
    wrap(
      <TextPanel
        disabled={false}
        conversation={[{ id: 'm1', direction: 'incoming', text: 'received text', receivedAt: 1 }]}
        onSend={() => true}
      />,
    );
    expect(screen.getByText('received text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy this message/i })).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  // Rendered without ToastProvider so role="status" is unambiguous.
  it('communicates state as text, not only color', () => {
    render(<StatusBadge status="ready" />);
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
  });

  it('shows waiting and error states', () => {
    const { rerender } = render(<StatusBadge status="waiting" />);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for a device');
    rerender(<StatusBadge status="error" />);
    expect(screen.getByRole('status')).toHaveTextContent('Connection problem');
  });
});

describe('NotFoundPage', () => {
  beforeEach(() => undefined);
  it('renders a friendly 404', () => {
    wrap(<NotFoundPage />);
    expect(screen.getByRole('heading', { name: /404/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to droply/i })).toHaveAttribute('href', '/');
  });
});
