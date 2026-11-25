import { useState } from 'react';
import { Download, Image as ImageIcon, Maximize2, Share2, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { PhotoMeta } from '../types/photo';
import {
  downloadOriginalPhoto,
  formatCountdown,
  formatTimeOfDay,
  getPhotoUrl,
  isMobileDevice,
  savePhotoToLibrary,
} from '../utils/photoSave';

interface GalleryViewProps {
  photos: PhotoMeta[];
  maxPhotos: number;
  ttlMs: number;
  serverNow: number;
  loading: boolean;
  error: string | null;
  isTeamAuthenticated: boolean;
  onOpenLightbox: (photoId: string) => void;
  onDeletePhoto: (photoId: string) => Promise<void>;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

export function GalleryView({
  photos,
  maxPhotos,
  ttlMs,
  serverNow,
  loading,
  error,
  isTeamAuthenticated,
  onOpenLightbox,
  onDeletePhoto,
  onNotify,
}: GalleryViewProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [brokenIds, setBrokenIds] = useState<Record<string, boolean>>({});
  const mobile = isMobileDevice();

  const handleSave = async (photo: PhotoMeta) => {
    setBusyId(photo.id);
    try {
      const outcome = await savePhotoToLibrary(photo);
      if (outcome === 'shared') {
        onNotify('Teilen-Menü geöffnet — dort „Bild sichern“ für Apple Fotos wählen.');
      } else if (outcome === 'downloaded') {
        onNotify('Originalfoto in voller Qualität gespeichert.');
      }
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Foto konnte nicht gespeichert werden.',
        'error',
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleDirectDownload = async (photo: PhotoMeta) => {
    setBusyId(photo.id);
    try {
      await downloadOriginalPhoto(photo);
      onNotify('Originaldatei wird in voller Qualität heruntergeladen.');
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Download fehlgeschlagen.',
        'error',
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (photoId: string) => {
    setBusyId(photoId);
    try {
      await onDeletePhoto(photoId);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-24 pt-10 sm:px-6 lg:px-8 lg:pt-12">
      {/* Minimalist photo-first header line */}
      <section className="flex flex-col gap-2 pb-8 sm:flex-row sm:items-baseline sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-[#111111] sm:text-3xl">
          Aktuelle Fotos
        </h1>
        <p className="font-mono text-xs tabular-nums text-zinc-500">
          {photos.length} / {maxPhotos} aktiv · 5 Min. verfügbar
        </p>
      </section>

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((slot) => (
            <div
              key={slot}
              className="overflow-hidden rounded-2xl border border-zinc-200 bg-white"
            >
              <div className="aspect-[4/3] animate-pulse bg-zinc-100" />
              <div className="flex items-center justify-between px-4 py-3.5">
                <div className="h-4 w-32 animate-pulse rounded bg-zinc-100" />
                <div className="h-9 w-24 animate-pulse rounded-lg bg-zinc-100" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pure Visitor Empty State — no admin or kiosk buttons */}
      {!loading && photos.length === 0 && (
        <section className="flex min-h-[54vh] flex-col items-center justify-center rounded-2xl border border-zinc-200/90 bg-white px-6 py-20 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 text-zinc-400">
            <ImageIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <h2 className="mt-5 font-serif text-2xl font-normal tracking-tight text-[#111111]">
            Gerade sind keine Fotos aktiv
          </h2>
          <p className="mt-2.5 max-w-sm text-sm leading-relaxed text-zinc-500">
            Neue Aufnahmen erscheinen hier automatisch und bleiben jeweils 5 Minuten in
            voller Qualität zum Herunterladen verfügbar.
          </p>
        </section>
      )}

      {/* Ordered Photo Grid (newest first) */}
      {!loading && photos.length > 0 && (
        <section
          aria-label="Aktuelle Fotos der letzten 5 Minuten"
          className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          <AnimatePresence initial={false} mode="popLayout">
            {photos.map((photo, index) => {
              const remainingMs = Math.max(0, photo.expiresAt - serverNow);
              const progressRatio = Math.max(0, Math.min(1, remainingMs / ttlMs));
              const isExpiringSoon = remainingMs <= 30_000;
              const isBusy = busyId === photo.id;
              const isBroken = Boolean(brokenIds[photo.id]);

              return (
                <motion.article
                  key={photo.id}
                  layout
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  className="group flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white"
                >
                  {/* Clickable photo frame */}
                  <div className="relative aspect-[4/3] w-full overflow-hidden bg-zinc-100">
                    {!isBroken ? (
                      <button
                        type="button"
                        onClick={() => onOpenLightbox(photo.id)}
                        className="block h-full w-full cursor-zoom-in text-left focus-visible:outline-2 focus-visible:-outline-offset-2"
                        aria-label={`Foto von ${formatTimeOfDay(photo.createdAt)} Uhr vergrößern`}
                      >
                        <img
                          src={getPhotoUrl(photo.id)}
                          alt={`Foto vom Tag der offenen Tür um ${formatTimeOfDay(photo.createdAt)} Uhr`}
                          referrerPolicy="no-referrer"
                          loading={index < 3 ? 'eager' : 'lazy'}
                          onError={() =>
                            setBrokenIds((prev) => ({ ...prev, [photo.id]: true }))
                          }
                          className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.02]"
                        />
                        <span className="pointer-events-none absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-lg bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100">
                          <Maximize2 className="h-4 w-4" aria-hidden="true" />
                        </span>
                      </button>
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-zinc-100 px-4 text-center text-zinc-500">
                        <ImageIcon className="h-6 w-6" aria-hidden="true" />
                        <span className="text-xs">Foto wird aktualisiert oder ist abgelaufen</span>
                      </div>
                    )}

                    {/* Subtle 5-minute expiry hairline */}
                    <div
                      aria-hidden="true"
                      className="absolute inset-x-0 bottom-0 h-[3px] bg-black/10"
                    >
                      <div
                        className={`h-full origin-left transition-colors duration-200 ${
                          isExpiringSoon ? 'bg-amber-600' : 'bg-[#2563EB]'
                        }`}
                        style={{ transform: `scaleX(${progressRatio})` }}
                      />
                    </div>
                  </div>

                  {/* Minimal metadata + Save action */}
                  <div className="flex flex-col gap-3 px-4 py-3.5">
                    <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                      <div className="flex items-center gap-2">
                        <span>{formatTimeOfDay(photo.createdAt)} Uhr</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`font-mono tabular-nums ${
                            isExpiringSoon
                              ? 'font-medium text-amber-700'
                              : 'text-zinc-700'
                          }`}
                        >
                          Noch {formatCountdown(remainingMs)}
                        </span>
                      </div>

                      {isExpiringSoon && (
                        <span className="font-medium text-amber-700">Gleich gelöscht</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleSave(photo)}
                        className="flex min-h-[42px] flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#111111] px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50"
                      >
                        {mobile ? (
                          <Share2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        ) : (
                          <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        )}
                        <span>{isBusy ? 'Lädt …' : 'In Fotos sichern'}</span>
                      </button>

                      {mobile && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleDirectDownload(photo)}
                          aria-label="Originaldatei direkt herunterladen"
                          title="Originaldatei direkt herunterladen"
                          className="flex min-h-[42px] min-w-[42px] shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-700 transition-colors hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50"
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}

                      {isTeamAuthenticated && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleDelete(photo.id)}
                          aria-label="Foto sofort löschen"
                          title="Foto sofort löschen"
                          className="flex min-h-[42px] min-w-[42px] shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        </section>
      )}
    </main>
  );
}
