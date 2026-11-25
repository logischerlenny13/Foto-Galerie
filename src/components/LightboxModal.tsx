import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Share2, Trash2, X } from 'lucide-react';
import type { PhotoMeta } from '../types/photo';
import {
  downloadOriginalPhoto,
  formatCountdown,
  formatFileSize,
  formatTimeOfDay,
  getPhotoUrl,
  isIOSDevice,
  isMobileDevice,
  savePhotoToLibrary,
} from '../utils/photoSave';

interface LightboxModalProps {
  photos: PhotoMeta[];
  activePhotoId: string | null;
  serverNow: number;
  isTeamAuthenticated: boolean;
  onClose: () => void;
  onSelectPhoto: (id: string) => void;
  onDeletePhoto: (id: string) => Promise<void>;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

export function LightboxModal({
  photos,
  activePhotoId,
  serverNow,
  isTeamAuthenticated,
  onClose,
  onSelectPhoto,
  onDeletePhoto,
  onNotify,
}: LightboxModalProps) {
  const [busy, setBusy] = useState(false);

  const currentIndex = activePhotoId
    ? photos.findIndex((item) => item.id === activePhotoId)
    : -1;
  const activePhoto = currentIndex >= 0 ? photos[currentIndex] : null;

  useEffect(() => {
    if (!activePhoto) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      } else if (event.key === 'ArrowLeft' && currentIndex > 0) {
        onSelectPhoto(photos[currentIndex - 1].id);
      } else if (event.key === 'ArrowRight' && currentIndex < photos.length - 1) {
        onSelectPhoto(photos[currentIndex + 1].id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activePhoto, currentIndex, onClose, onSelectPhoto, photos]);

  // Close gracefully if the viewed photo expires
  useEffect(() => {
    if (activePhotoId && !activePhoto) {
      onClose();
    }
  }, [activePhoto, activePhotoId, onClose]);

  if (!activePhoto) return null;

  const remainingMs = Math.max(0, activePhoto.expiresAt - serverNow);
  const mobile = isMobileDevice();
  const ios = isIOSDevice();

  const handleSave = async () => {
    setBusy(true);
    try {
      const outcome = await savePhotoToLibrary(activePhoto);
      if (outcome === 'shared') {
        onNotify('Im Teilen-Menü „Bild sichern“ wählen, um das Original in Fotos abzulegen.');
      } else if (outcome === 'downloaded') {
        onNotify('Originalfoto in voller Qualität gespeichert.');
      }
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Foto konnte nicht gespeichert werden.',
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    setBusy(true);
    try {
      await downloadOriginalPhoto(activePhoto);
      onNotify('Originaldatei wird heruntergeladen.');
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Download fehlgeschlagen.',
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await onDeletePhoto(activePhoto.id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Foto in voller Auflösung"
      className="fixed inset-0 z-50 flex flex-col bg-[#08080A]/95 text-white backdrop-blur-md"
    >
      {/* Top Bar */}
      <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-zinc-300">
          <span>{formatTimeOfDay(activePhoto.createdAt)} Uhr</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums text-white">
            Noch {formatCountdown(remainingMs)}
          </span>
          {activePhoto.width && activePhoto.height && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {activePhoto.width} × {activePhoto.height}
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">{formatFileSize(activePhoto.sizeBytes)}</span>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Vollbild schließen"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* Main Image Stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 py-2 sm:px-14">
        {currentIndex > 0 && (
          <button
            type="button"
            onClick={() => onSelectPhoto(photos[currentIndex - 1].id)}
            aria-label="Vorheriges Foto"
            className="absolute left-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/80 sm:left-6"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
        )}

        <img
          src={getPhotoUrl(activePhoto.id)}
          alt={`Aufnahme vom Tag der offenen Tür (${formatTimeOfDay(activePhoto.createdAt)} Uhr)`}
          referrerPolicy="no-referrer"
          className="max-h-full max-w-full rounded-lg object-contain"
        />

        {currentIndex < photos.length - 1 && (
          <button
            type="button"
            onClick={() => onSelectPhoto(photos[currentIndex + 1].id)}
            aria-label="Nächstes Foto"
            className="absolute right-3 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/80 sm:right-6"
          >
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Action Footer */}
      <div className="border-t border-white/10 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col items-center justify-between gap-3 sm:flex-row">
          <p className="text-center text-xs text-zinc-400 sm:text-left">
            {ios
              ? 'Tipp für iPhone & iPad: Auf „In Fotos sichern“ tippen und im Menü „Bild sichern“ wählen.'
              : 'Originaldatei ohne Komprimierung — direkt für deine Fotomediathek.'}
          </p>

          <div className="flex w-full items-center justify-center gap-2.5 sm:w-auto">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSave()}
              className="flex min-h-[44px] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#2563EB] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#1D4ED8] disabled:opacity-50 sm:flex-initial"
            >
              {mobile ? (
                <Share2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>{busy ? 'Lädt …' : 'In Fotos sichern'}</span>
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => void handleDownload()}
              className="flex min-h-[44px] items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-white/15 disabled:opacity-50"
            >
              <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Original laden</span>
            </button>

            {isTeamAuthenticated && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleDelete()}
                aria-label="Foto sofort löschen"
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
