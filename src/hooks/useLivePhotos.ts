import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveSocketEvent, PhotoMeta } from '../types/photo';

interface UseLivePhotosResult {
  photos: PhotoMeta[];
  maxPhotos: number;
  ttlMs: number;
  serverNow: number;
  loading: boolean;
  error: string | null;
  refreshNow: () => Promise<void>;
  removeLocalPhoto: (id: string) => void;
  upsertLocalPhoto: (photo: PhotoMeta, serverTime?: number) => void;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PHOTOS = 30;

export function useLivePhotos(): UseLivePhotosResult {
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [maxPhotos, setMaxPhotos] = useState<number>(DEFAULT_MAX_PHOTOS);
  const [ttlMs, setTtlMs] = useState<number>(DEFAULT_TTL_MS);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const clockOffsetRef = useRef<number>(0);
  const wsConnectedRef = useRef<boolean>(false);

  const syncClock = useCallback((serverTime: number) => {
    clockOffsetRef.current = serverTime - Date.now();
  }, []);

  const getEstimatedServerNow = useCallback(() => {
    return Date.now() + clockOffsetRef.current;
  }, []);

  const fetchSnapshot = useCallback(async () => {
    try {
      const response = await fetch('/api/photos', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Galerie konnte nicht geladen werden.');
      }
      const data = (await response.json()) as {
        serverNow: number;
        ttlMs?: number;
        maxPhotos?: number;
        photos: PhotoMeta[];
      };

      syncClock(data.serverNow);
      if (typeof data.ttlMs === 'number') setTtlMs(data.ttlMs);
      if (typeof data.maxPhotos === 'number') setMaxPhotos(data.maxPhotos);

      const ordered = [...data.photos].sort((a, b) => b.createdAt - a.createdAt);
      setPhotos(ordered);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verbindung unterbrochen.');
    } finally {
      setLoading(false);
    }
  }, [syncClock]);

  const upsertLocalPhoto = useCallback(
    (photo: PhotoMeta, serverTime?: number) => {
      if (typeof serverTime === 'number') {
        syncClock(serverTime);
      }
      setPhotos((prev) => {
        if (prev.some((item) => item.id === photo.id)) {
          return prev;
        }
        return [photo, ...prev].sort((a, b) => b.createdAt - a.createdAt);
      });
    },
    [syncClock],
  );

  const removeLocalPhoto = useCallback((id: string) => {
    setPhotos((prev) => prev.filter((item) => item.id !== id));
  }, []);

  // Initial REST snapshot
  useEffect(() => {
    void fetchSnapshot();
  }, [fetchSnapshot]);

  // Real-time WebSocket connection with automatic reconnect & Cloudflare Pages polling fallback
  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let fallbackPollTimer: number | null = null;
    let attempt = 0;

    const startFallbackPolling = () => {
      if (fallbackPollTimer !== null) return;
      fallbackPollTimer = window.setInterval(() => {
        if (!wsConnectedRef.current && document.visibilityState === 'visible') {
          void fetchSnapshot();
        }
      }, 2500);
    };

    const stopFallbackPolling = () => {
      if (fallbackPollTimer !== null) {
        window.clearInterval(fallbackPollTimer);
        fallbackPollTimer = null;
      }
    };

    const connect = () => {
      if (!active) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;

      try {
        socket = new WebSocket(wsUrl);
      } catch {
        startFallbackPolling();
        return;
      }

      socket.onopen = () => {
        if (!active) return;
        wsConnectedRef.current = true;
        attempt = 0;
        stopFallbackPolling();
        setError(null);
      };

      socket.onmessage = (event) => {
        if (!active) return;
        try {
          const message = JSON.parse(String(event.data)) as LiveSocketEvent;
          if (message.type === 'init') {
            syncClock(message.serverNow);
            setTtlMs(message.ttlMs);
            setMaxPhotos(message.maxPhotos);
            const ordered = [...message.photos].sort((a, b) => b.createdAt - a.createdAt);
            setPhotos(ordered);
            setLoading(false);
          } else if (message.type === 'photo:created') {
            upsertLocalPhoto(message.photo, message.serverNow);
          } else if (message.type === 'photo:expired') {
            syncClock(message.serverNow);
            removeLocalPhoto(message.id);
          }
        } catch {
          // Ignore malformed frames
        }
      };

      socket.onclose = () => {
        if (!active) return;
        wsConnectedRef.current = false;
        startFallbackPolling();
        attempt += 1;
        const delayMs = Math.min(12000, 1000 * Math.pow(1.6, Math.min(attempt, 6)));
        reconnectTimer = window.setTimeout(connect, delayMs);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchSnapshot();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      active = false;
      wsConnectedRef.current = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      stopFallbackPolling();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
    };
  }, [fetchSnapshot, removeLocalPhoto, syncClock, upsertLocalPhoto]);

  // Synchronized 1-second tick for 5-minute countdowns and client-side expiry cleanup
  useEffect(() => {
    const timer = window.setInterval(() => {
      const estimatedNow = getEstimatedServerNow();
      setNowTick(estimatedNow);
      setPhotos((prev) => {
        const hasExpired = prev.some((item) => item.expiresAt <= estimatedNow);
        if (!hasExpired) return prev;
        return prev.filter((item) => item.expiresAt > estimatedNow);
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [getEstimatedServerNow]);

  const currentServerNow = Math.max(nowTick, getEstimatedServerNow());
  const visiblePhotos = photos.filter((item) => item.expiresAt > currentServerNow);

  return {
    photos: visiblePhotos,
    maxPhotos,
    ttlMs,
    serverNow: currentServerNow,
    loading,
    error,
    refreshNow: fetchSnapshot,
    removeLocalPhoto,
    upsertLocalPhoto,
  };
}
