import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { PhotoMeta } from '../types/photo';
import { getPhotoUrl } from '../utils/photoSave';

interface KioskViewProps {
  photos: PhotoMeta[];
  onExit: () => void;
}

export function KioskView({ photos, onExit }: KioskViewProps) {
  const [slotCount, setSlotCount] = useState<2 | 3>(3);
  const [controlsVisible, setControlsVisible] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const hideTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Strictly show ONLY the latest 2 or 3 active photos, ordered newest first
  const displayedPhotos = photos.slice(0, slotCount);

  const revealControlsTemporarily = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, 3000);
  }, []);

  useEffect(() => {
    revealControlsTemporarily();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [revealControlsTemporarily]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await (containerRef.current ?? document.documentElement).requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Fullscreen may be restricted inside an iframe; continue seamlessly in viewport mode
    }
  }, []);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!document.fullscreenElement) {
          onExit();
        }
      } else if (event.key === '2') {
        setSlotCount(2);
        revealControlsTemporarily();
      } else if (event.key === '3') {
        setSlotCount(3);
        revealControlsTemporarily();
      } else if (event.key.toLowerCase() === 'f') {
        void toggleFullscreen();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExit, revealControlsTemporarily, toggleFullscreen]);

  return (
    <div
      ref={containerRef}
      onMouseMove={revealControlsTemporarily}
      onTouchStart={revealControlsTemporarily}
      className={`fixed inset-0 z-40 flex h-[100dvh] w-screen flex-col overflow-hidden bg-[#050505] text-white ${
        controlsVisible ? 'cursor-default' : 'cursor-none'
      }`}
    >
      {/* Pure projection stage — zero countdowns, zero QR, zero text overlays */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6 lg:p-8">
        {displayedPhotos.length === 0 && (
          <div className="flex flex-col items-center justify-center px-6 text-center">
            <p className="font-serif text-3xl font-normal tracking-tight text-zinc-200 sm:text-5xl">
              Tag der offenen Tür
            </p>
            <p className="mt-4 text-sm tracking-wide text-zinc-500">
              Neue Aufnahmen erscheinen hier automatisch
            </p>
          </div>
        )}

        {displayedPhotos.length === 1 && (
          <div className="flex h-full w-full items-center justify-center">
            <AnimatePresence mode="popLayout">
              <motion.figure
                key={displayedPhotos[0].id}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                className="flex h-full max-h-[90dvh] w-full max-w-[92vw] items-center justify-center overflow-hidden rounded-2xl border border-zinc-800/80 bg-[#0D0D10]"
              >
                <img
                  src={getPhotoUrl(displayedPhotos[0].id)}
                  alt="Aktuellstes Foto vom Tag der offenen Tür"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-contain"
                />
              </motion.figure>
            </AnimatePresence>
          </div>
        )}

        {displayedPhotos.length === 2 && (
          <div className="grid h-full w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:gap-6">
            <AnimatePresence mode="popLayout">
              {displayedPhotos.map((photo, idx) => (
                <motion.figure
                  key={photo.id}
                  layout
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                  className="relative flex min-h-0 h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-zinc-800/80 bg-[#0D0D10]"
                >
                  <img
                    src={getPhotoUrl(photo.id)}
                    alt={idx === 0 ? 'Neuestes Foto' : 'Vorheriges Foto'}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                </motion.figure>
              ))}
            </AnimatePresence>
          </div>
        )}

        {displayedPhotos.length === 3 && (
          <div className="grid h-full w-full grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-6">
            {/* Newest photo takes prominent left 7/12 stage */}
            <AnimatePresence mode="popLayout">
              <motion.figure
                key={displayedPhotos[0].id}
                layout
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                className="relative flex min-h-0 h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-zinc-800/80 bg-[#0D0D10] lg:col-span-7"
              >
                <img
                  src={getPhotoUrl(displayedPhotos[0].id)}
                  alt="Neuestes Foto"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              </motion.figure>
            </AnimatePresence>

            {/* 2nd and 3rd newest ordered cleanly on the right 5/12 */}
            <div className="grid min-h-0 grid-cols-2 gap-4 lg:col-span-5 lg:grid-cols-1 lg:grid-rows-2 lg:gap-6">
              <AnimatePresence mode="popLayout">
                {displayedPhotos.slice(1, 3).map((photo, idx) => (
                  <motion.figure
                    key={photo.id}
                    layout
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                    className="relative flex min-h-0 h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-zinc-800/80 bg-[#0D0D10]"
                  >
                    <img
                      src={getPhotoUrl(photo.id)}
                      alt={idx === 0 ? 'Zweitneuestes Foto' : 'Drittneuestes Foto'}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  </motion.figure>
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>

      {/* Auto-hiding minimal corner controls (invisible during unattended projection) */}
      <div
        className={`fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-xl border border-zinc-800 bg-[#111113]/90 p-1.5 backdrop-blur-md transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="flex items-center rounded-lg bg-zinc-900 p-0.5">
          <button
            type="button"
            onClick={() => setSlotCount(2)}
            className={`min-h-[34px] whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors ${
              slotCount === 2 ? 'bg-white text-[#111111]' : 'text-zinc-400 hover:text-white'
            }`}
          >
            2 Fotos
          </button>
          <button
            type="button"
            onClick={() => setSlotCount(3)}
            className={`min-h-[34px] whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors ${
              slotCount === 3 ? 'bg-white text-[#111111]' : 'text-zinc-400 hover:text-white'
            }`}
          >
            3 Fotos
          </button>
        </div>

        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-label={isFullscreen ? 'Vollbild verlassen' : 'Vollbild aktivieren'}
          className="flex h-[36px] w-[36px] items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
        >
          {isFullscreen ? (
            <Minimize className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Maximize className="h-4 w-4" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={onExit}
          className="flex min-h-[36px] items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Beenden</span>
        </button>
      </div>
    </div>
  );
}
