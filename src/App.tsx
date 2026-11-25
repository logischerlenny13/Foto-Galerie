import { useCallback, useEffect, useState } from 'react';
import { GalleryView } from './components/GalleryView';
import { KioskView } from './components/KioskView';
import { LightboxModal } from './components/LightboxModal';
import { PrivacyView } from './components/PrivacyView';
import { SettingsView } from './components/SettingsView';
import { TopBar } from './components/TopBar';
import { useLivePhotos } from './hooks/useLivePhotos';
import type { AuthStatus, ViewMode } from './types/photo';

interface ToastState {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

function getInitialViewFromPath(): { view: ViewMode; wantsKiosk: boolean } {
  const path = window.location.pathname.toLowerCase();
  if (path.startsWith('/kiosk')) return { view: 'settings', wantsKiosk: true };
  if (path.startsWith('/einstellungen') || path.startsWith('/upload')) {
    return { view: 'settings', wantsKiosk: false };
  }
  if (path.startsWith('/datenschutz')) return { view: 'privacy', wantsKiosk: false };
  return { view: 'gallery', wantsKiosk: false };
}

function getPathForView(view: ViewMode): string {
  switch (view) {
    case 'kiosk':
      return '/kiosk';
    case 'settings':
      return '/einstellungen';
    case 'privacy':
      return '/datenschutz';
    default:
      return '/';
  }
}

export default function App() {
  const initial = getInitialViewFromPath();
  const [viewMode, setViewMode] = useState<ViewMode>(initial.view);
  const [pendingKioskRedirect, setPendingKioskRedirect] = useState<boolean>(initial.wantsKiosk);
  const [lightboxPhotoId, setLightboxPhotoId] = useState<string | null>(null);
  const [teamToken, setTeamToken] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const {
    photos,
    maxPhotos,
    ttlMs,
    serverNow,
    loading,
    error,
    removeLocalPhoto,
    upsertLocalPhoto,
  } = useLivePhotos();

  const notify = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now();
    setToast({ id, message, tone });
    window.setTimeout(() => {
      setToast((current) => (current && current.id === id ? null : current));
    }, 3600);
  }, []);

  const navigate = useCallback(
    (nextView: ViewMode) => {
      // Kiosk mode requires PIN authentication first
      if (nextView === 'kiosk' && !teamToken) {
        setPendingKioskRedirect(true);
        setViewMode('settings');
        if (window.location.pathname !== '/einstellungen') {
          window.history.pushState({ view: 'settings' }, '', '/einstellungen');
        }
        return;
      }

      if (nextView !== 'settings') {
        setPendingKioskRedirect(false);
      }
      setViewMode(nextView);
      const nextPath = getPathForView(nextView);
      if (window.location.pathname !== nextPath) {
        window.history.pushState({ view: nextView }, '', nextPath);
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    [teamToken],
  );

  useEffect(() => {
    const handlePopState = () => {
      const next = getInitialViewFromPath();
      if (next.wantsKiosk && teamToken) {
        setViewMode('kiosk');
        setPendingKioskRedirect(false);
      } else {
        setViewMode(next.view);
        setPendingKioskRedirect(next.wantsKiosk);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [teamToken]);

  const fetchAuthStatus = useCallback(async (token: string | null) => {
    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch('/api/auth/status', { headers, cache: 'no-store' });
      if (!response.ok) return;
      const data = (await response.json()) as AuthStatus;
      setAuthStatus(data);
      if (token && !data.authenticated) {
        setTeamToken(null);
      }
    } catch {
      // Ignore transient network errors
    }
  }, []);

  useEffect(() => {
    void fetchAuthStatus(teamToken);
  }, [fetchAuthStatus, teamToken]);

  const handleAuthSuccess = useCallback(
    (token: string) => {
      setTeamToken(token);
      setAuthStatus((prev) => ({
        configured: true,
        envManaged: prev?.envManaged ?? false,
        authenticated: true,
      }));
      if (pendingKioskRedirect) {
        setPendingKioskRedirect(false);
        setViewMode('kiosk');
        if (window.location.pathname !== '/kiosk') {
          window.history.pushState({ view: 'kiosk' }, '', '/kiosk');
        }
      }
    },
    [pendingKioskRedirect],
  );

  const handleLogout = useCallback(async () => {
    const current = teamToken;
    setTeamToken(null);
    setPendingKioskRedirect(false);
    if (current) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${current}` },
        });
      } catch {
        // Ignore logout network failures
      }
    }
    notify('Team-Sitzung beendet.');
  }, [notify, teamToken]);

  const handleDeletePhoto = useCallback(
    async (photoId: string) => {
      if (!teamToken) {
        notify('Bitte zuerst in den Einstellungen mit der Team-PIN anmelden.', 'error');
        return;
      }

      try {
        const response = await fetch(`/api/photos/${encodeURIComponent(photoId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${teamToken}` },
        });

        if (response.status === 401) {
          await handleLogout();
          notify('Sitzung abgelaufen — bitte erneut mit Team-PIN anmelden.', 'error');
          return;
        }

        if (!response.ok && response.status !== 404) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || 'Foto konnte nicht gelöscht werden.');
        }

        removeLocalPhoto(photoId);
        notify('Foto sofort gelöscht.');
      } catch (err) {
        notify(
          err instanceof Error ? err.message : 'Foto konnte nicht gelöscht werden.',
          'error',
        );
      }
    },
    [handleLogout, notify, removeLocalPhoto, teamToken],
  );

  // Fullscreen dark Beamer Kiosk Mode (only accessible after PIN login)
  if (viewMode === 'kiosk' && teamToken) {
    return (
      <KioskView
        photos={photos}
        onExit={() => navigate('settings')}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#FAFAFA] text-[#111111]">
      <TopBar
        activeView={viewMode}
        onNavigate={navigate}
        isTeamAuthenticated={Boolean(teamToken)}
      />

      <div className="flex-1">
        {viewMode === 'gallery' && (
          <GalleryView
            photos={photos}
            maxPhotos={maxPhotos}
            ttlMs={ttlMs}
            serverNow={serverNow}
            loading={loading}
            error={error}
            isTeamAuthenticated={Boolean(teamToken)}
            onOpenLightbox={(id) => setLightboxPhotoId(id)}
            onDeletePhoto={handleDeletePhoto}
            onNotify={notify}
          />
        )}

        {viewMode === 'settings' && (
          <SettingsView
            authStatus={authStatus}
            teamToken={teamToken}
            photos={photos}
            maxPhotos={maxPhotos}
            serverNow={serverNow}
            pendingKioskRedirect={pendingKioskRedirect}
            onAuthSuccess={handleAuthSuccess}
            onLogout={handleLogout}
            onPhotoUploaded={upsertLocalPhoto}
            onDeletePhoto={handleDeletePhoto}
            onLaunchKiosk={() => navigate('kiosk')}
            onNotify={notify}
          />
        )}

        {viewMode === 'privacy' && (
          <PrivacyView
            maxPhotos={maxPhotos}
            onBackToGallery={() => navigate('gallery')}
          />
        )}
      </div>

      {/* Minimal footer at the very bottom: only Privacy link */}
      <footer className="border-t border-zinc-200/70 bg-[#FAFAFA]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-7 text-xs text-zinc-500 sm:px-6 lg:px-8">
          <p>Automatische Löschung nach 5 Minuten</p>
          <button
            type="button"
            onClick={() => navigate('privacy')}
            className="min-h-[36px] shrink-0 whitespace-nowrap font-medium text-zinc-600 underline-offset-4 transition-colors hover:text-[#111111] hover:underline"
          >
            Datenschutz
          </button>
        </div>
      </footer>

      <LightboxModal
        photos={photos}
        activePhotoId={lightboxPhotoId}
        serverNow={serverNow}
        isTeamAuthenticated={Boolean(teamToken)}
        onClose={() => setLightboxPhotoId(null)}
        onSelectPhoto={(id) => setLightboxPhotoId(id)}
        onDeletePhoto={handleDeletePhoto}
        onNotify={notify}
      />

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-5 left-1/2 z-50 max-w-[92vw] -translate-x-1/2 rounded-xl px-4 py-2.5 text-xs font-medium shadow-lg ${
            toast.tone === 'error'
              ? 'bg-red-700 text-white'
              : 'bg-[#111111] text-white'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
