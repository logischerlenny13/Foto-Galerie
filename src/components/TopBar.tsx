import { ArrowLeft, Settings } from 'lucide-react';
import type { ViewMode } from '../types/photo';

interface TopBarProps {
  activeView: ViewMode;
  onNavigate: (view: ViewMode) => void;
  isTeamAuthenticated: boolean;
}

export function TopBar({ activeView, onNavigate, isTeamAuthenticated }: TopBarProps) {
  const isGallery = activeView === 'gallery';

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200/80 bg-[#FAFAFA]/92 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-8 px-4 sm:px-6 lg:px-8">
        {/* Left: Clean single-line brand wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('gallery')}
          className="shrink-0 whitespace-nowrap text-base font-semibold tracking-tight text-[#111111] transition-colors hover:text-[#2563EB] sm:text-lg"
        >
          Tag der offenen Tür
        </button>

        {/* Right: Minimal Settings button (or Back to Gallery when outside gallery) */}
        <div className="flex shrink-0 items-center gap-3">
          {!isGallery && (
            <button
              type="button"
              onClick={() => onNavigate('gallery')}
              className="flex min-h-[40px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:text-[#111111]"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Zur Galerie</span>
            </button>
          )}

          {activeView !== 'settings' && (
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              aria-label="Einstellungen öffnen"
              className={`flex min-h-[40px] shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors ${
                isTeamAuthenticated
                  ? 'border-[#111111] bg-[#111111] text-white hover:bg-zinc-800'
                  : 'border-zinc-200 bg-white text-[#111111] hover:border-zinc-300 hover:bg-zinc-50'
              }`}
            >
              <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Einstellungen</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
