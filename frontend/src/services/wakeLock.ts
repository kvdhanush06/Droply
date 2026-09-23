/**
 * Screen Wake Lock API wrapper. Keeps the display awake during active
 * transfers so background throttling cannot stall them. Gracefully returns
 * null on browsers without support or when permission is refused.
 */

export interface WakeLockHandle {
  release(): Promise<void>;
  readonly released: boolean;
}

type Sentinel = {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
};

export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export async function requestWakeLock(): Promise<WakeLockHandle | null> {
  try {
    const wakeLock = (navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<Sentinel> };
    }).wakeLock;
    if (!wakeLock) return null;
    const sentinel = await wakeLock.request('screen');
    return {
      get released() {
        return sentinel.released;
      },
      release: async () => {
        try {
          await sentinel.release();
        } catch {
          /* already released */
        }
      },
    };
  } catch {
    return null;
  }
}
