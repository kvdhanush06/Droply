/**
 * Local device identity. The device name is chosen by the user, stored only
 * in this browser's localStorage and shared with room peers over the
 * encrypted data channel (never with the signaling server).
 */

const STORAGE_KEY = 'droply-device-name';
export const MAX_DEVICE_NAME_LENGTH = 40;

/**
 * Trims, strips control characters and caps the length. Returns null when
 * nothing usable remains. Applied to local input AND to names received from
 * peers (untrusted data — always rendered as text nodes by React).
 */
export function sanitizeDeviceName(raw: string): string | null {
  let out = '';
  for (const ch of raw) {
    // Drop C0/C1 controls, format characters (zero-width joiners, …) and the
    // line/paragraph separators, all of which enable visual spoofing in
    // device names. Interior spaces (Zs) are legitimate and kept.
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch)) continue;
    out += ch;
  }
  const trimmed = out.trim().slice(0, MAX_DEVICE_NAME_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function loadDeviceName(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? sanitizeDeviceName(stored) : null;
  } catch {
    return null; // storage unavailable (private mode, hardened browser)
  }
}

export function saveDeviceName(name: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* storage unavailable — the name still lives in memory */
  }
}
