import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { RoomSession, type RoomSnapshot } from '../services/room/roomSession';
import { loadServerConfig, signalingUrl } from '../config/env';

interface RoomContextValue {
  session: RoomSession;
  snapshot: RoomSnapshot;
}

const RoomContext = createContext<RoomContextValue | null>(null);

/**
 * Owns the single RoomSession for the app lifetime, so navigating between
 * the landing page and the room page never tears down the connection.
 */
export function RoomProvider({ children }: { children: ReactNode }) {
  const sessionRef = useRef<RoomSession | null>(null);

  if (sessionRef.current === null) {
    // ICE servers arrive asynchronously; start with STUN fallback immediately
    // and swap in the server-provided list before any room is created.
    sessionRef.current = new RoomSession(signalingUrl(), [{ urls: ['stun:stun.l.google.com:19302'] }]);
  }

  useEffect(() => {
    const session = sessionRef.current!;
    void loadServerConfig().then((config) => {
      session.updateIceServers(config.iceServers);
    });
    return () => {
      // Intentionally keep the session alive across route changes; only
      // dispose when the whole app unmounts (page unload).
    };
  }, []);

  const snapshot = useSyncExternalStore(
    (listener) => sessionRef.current!.subscribe(listener),
    () => sessionRef.current!.getSnapshot(),
  );

  const value = useMemo<RoomContextValue>(
    () => ({ session: sessionRef.current!, snapshot }),
    [snapshot],
  );

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

export function useRoomSession(): RoomContextValue {
  const ctx = useContext(RoomContext);
  if (!ctx) throw new Error('useRoomSession must be used inside <RoomProvider>');
  return ctx;
}
