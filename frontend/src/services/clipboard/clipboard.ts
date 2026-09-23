/** Clipboard helpers with graceful fallbacks and honest error reporting. */

export type ClipboardResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'unsupported' | 'denied' | 'empty' | 'error' };

export async function readClipboardText(): Promise<ClipboardResult> {
  if (!('clipboard' in navigator) || typeof navigator.clipboard?.readText !== 'function') {
    return { ok: false, reason: 'unsupported' };
  }
  try {
    const text = await navigator.clipboard.readText();
    if (!text || text.length === 0) return { ok: false, reason: 'empty' };
    return { ok: true, text };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return { ok: false, reason: 'denied' };
    return { ok: false, reason: 'error' };
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if ('clipboard' in navigator && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path below.
    }
  }
  // Legacy fallback for non-secure contexts or older browsers.
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function clipboardErrorMessage(reason: Exclude<ClipboardResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'unsupported':
      return 'This browser can’t read the clipboard directly — paste into the text box (Ctrl+V) instead.';
    case 'denied':
      return 'Clipboard permission was denied. Allow clipboard access in your browser and try again.';
    case 'empty':
      return 'Your clipboard is empty.';
    case 'error':
      return 'Could not read the clipboard.';
  }
}

/** True when the Web Share API can share a URL. */
export function canShare(): boolean {
  return typeof navigator.share === 'function';
}

export async function shareLink(title: string, text: string, url: string): Promise<boolean> {
  if (!canShare()) return false;
  try {
    await navigator.share({ title, text, url });
    return true;
  } catch {
    return false; // User cancelled or share failed.
  }
}
