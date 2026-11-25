import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import { Camera, Check, Lock, LogOut, Monitor, Trash2, Upload } from 'lucide-react';
import type { AuthStatus, PhotoMeta, SettingsTab } from '../types/photo';
import {
  formatCountdown,
  formatFileSize,
  formatTimeOfDay,
  getPhotoUrl,
} from '../utils/photoSave';
import { CloudflareGuideView } from './CloudflareGuideView';
import { FolderWatcherPanel } from './FolderWatcherPanel';

interface SettingsViewProps {
  authStatus: AuthStatus | null;
  teamToken: string | null;
  photos: PhotoMeta[];
  maxPhotos: number;
  serverNow: number;
  pendingKioskRedirect: boolean;
  onAuthSuccess: (token: string) => void;
  onLogout: () => Promise<void>;
  onPhotoUploaded: (photo: PhotoMeta, serverTime?: number) => void;
  onDeletePhoto: (id: string) => Promise<void>;
  onLaunchKiosk: () => void;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

interface UploadQueueItem {
  id: string;
  name: string;
  status: 'uploading' | 'done' | 'error';
  message?: string;
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function SettingsView({
  authStatus,
  teamToken,
  photos,
  maxPhotos,
  serverNow,
  pendingKioskRedirect,
  onAuthSuccess,
  onLogout,
  onPhotoUploaded,
  onDeletePhoto,
  onLaunchKiosk,
  onNotify,
}: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('upload');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [isDragging, setIsDragging] = useState(false);
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const needsSetup = authStatus !== null && !authStatus.configured;
  const isAuthenticated = Boolean(teamToken);

  const handleSetupSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setAuthError(null);

    const trimmed = pin.trim();
    if (trimmed.length < 4 || trimmed.length > 32) {
      setAuthError('Bitte eine Team-PIN mit 4 bis 32 Zeichen eingeben.');
      return;
    }
    if (trimmed !== confirmPin.trim()) {
      setAuthError('Die beiden PIN-Eingaben stimmen nicht überein.');
      return;
    }

    setAuthBusy(true);
    try {
      const response = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: trimmed }),
      });
      const data = (await response.json()) as { token?: string; error?: string };
      if (!response.ok || !data.token) {
        throw new Error(data.error || 'PIN konnte nicht eingerichtet werden.');
      }
      setPin('');
      setConfirmPin('');
      onAuthSuccess(data.token);
      onNotify('Team-PIN gespeichert — Einstellungen freigeschaltet.');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Einrichtung fehlgeschlagen.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLoginSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setAuthError(null);

    const trimmed = pin.trim();
    if (!trimmed) {
      setAuthError('Bitte die Team-PIN eingeben.');
      return;
    }

    setAuthBusy(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: trimmed }),
      });
      const data = (await response.json()) as { token?: string; error?: string };
      if (!response.ok || !data.token) {
        throw new Error(data.error || 'Anmeldung fehlgeschlagen.');
      }
      setPin('');
      onAuthSuccess(data.token);
      onNotify('Einstellungen freigeschaltet.');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen.');
    } finally {
      setAuthBusy(false);
    }
  };

  const uploadFiles = async (fileList: FileList | File[]) => {
    if (!teamToken) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;

    for (const file of files) {
      const itemId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
        setQueue((prev) => [
          {
            id: itemId,
            name: file.name,
            status: 'error',
            message: 'Nur JPEG-, PNG- oder WebP-Fotos werden unterstützt.',
          },
          ...prev.slice(0, 7),
        ]);
        continue;
      }

      if (file.size > MAX_FILE_BYTES) {
        setQueue((prev) => [
          {
            id: itemId,
            name: file.name,
            status: 'error',
            message: 'Größer als 15 MB.',
          },
          ...prev.slice(0, 7),
        ]);
        continue;
      }

      setQueue((prev) => [
        { id: itemId, name: file.name, status: 'uploading' },
        ...prev.slice(0, 7),
      ]);

      try {
        const formData = new FormData();
        formData.append('photo', file, file.name);

        const response = await fetch('/api/photos', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${teamToken}`,
          },
          body: formData,
        });

        const data = (await response.json()) as {
          photo?: PhotoMeta;
          serverNow?: number;
          error?: string;
        };

        if (!response.ok || !data.photo) {
          if (response.status === 401) {
            await onLogout();
          }
          throw new Error(data.error || 'Upload fehlgeschlagen.');
        }

        onPhotoUploaded(data.photo, data.serverNow);
        setQueue((prev) =>
          prev.map((item) =>
            item.id === itemId
              ? { ...item, status: 'done', message: 'Live für 5:00 Min.' }
              : item,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload fehlgeschlagen.';
        setQueue((prev) =>
          prev.map((item) =>
            item.id === itemId ? { ...item, status: 'error', message } : item,
          ),
        );
        onNotify(message, 'error');
      }
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      void uploadFiles(event.target.files);
      event.target.value = '';
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files) {
      void uploadFiles(event.dataTransfer.files);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await onDeletePhoto(id);
    } finally {
      setDeletingId(null);
    }
  };

  // PIN Gate before accessing Upload, Auto Folder Watcher, Kiosk Mode, or Cloudflare Setup
  if (!isAuthenticated) {
    return (
      <main className="mx-auto w-full max-w-md px-4 pb-24 pt-14 sm:px-6 lg:pt-20">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 text-[#111111]">
            <Lock className="h-5 w-5" aria-hidden="true" />
          </div>

          <h1 className="mt-5 text-2xl font-semibold tracking-tight text-[#111111]">
            {needsSetup ? 'Team-PIN einmalig festlegen' : 'Einstellungen (Team-PIN)'}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            {needsSetup
              ? 'Lege einmalig eine Team-PIN fest, um Fotos hochzuladen, die Ordner-Automatik zu nutzen und den Beamer-Kiosk zu starten.'
              : pendingKioskRedirect
                ? 'Bitte mit der Team-PIN anmelden, um den Beamer-Kiosk zu öffnen.'
                : 'Melde dich mit der Team-PIN an, um Fotos hochzuladen, den Kamera-Ordner zu verbinden oder den Beamer-Kiosk zu starten.'}
          </p>

          <form
            onSubmit={needsSetup ? handleSetupSubmit : handleLoginSubmit}
            className="mt-6 space-y-4"
          >
            <div>
              <label
                htmlFor="settings-pin-input"
                className="block text-xs font-medium text-zinc-700"
              >
                {needsSetup ? 'Neue Team-PIN (4–32 Zeichen)' : 'Team-PIN'}
              </label>
              <input
                id="settings-pin-input"
                type="password"
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="z. B. 2026-campus"
                className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-[#111111] placeholder:text-zinc-400 focus:border-[#2563EB] focus:outline-none"
                required
              />
            </div>

            {needsSetup && (
              <div>
                <label
                  htmlFor="settings-pin-confirm"
                  className="block text-xs font-medium text-zinc-700"
                >
                  Team-PIN bestätigen
                </label>
                <input
                  id="settings-pin-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value)}
                  placeholder="PIN wiederholen"
                  className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-[#111111] placeholder:text-zinc-400 focus:border-[#2563EB] focus:outline-none"
                  required
                />
              </div>
            )}

            {authError && (
              <p role="alert" className="text-xs font-medium text-red-700">
                {authError}
              </p>
            )}

            <button
              type="submit"
              disabled={authBusy}
              className="min-h-[44px] w-full rounded-lg bg-[#2563EB] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#1D4ED8] disabled:opacity-50"
            >
              {authBusy
                ? 'Prüfe …'
                : needsSetup
                  ? 'PIN speichern & öffnen'
                  : 'Anmelden'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  // Authenticated Settings Hub
  return (
    <main className="mx-auto w-full max-w-4xl px-4 pb-24 pt-10 sm:px-6 lg:pt-12">
      {/* Header & Logout */}
      <section className="flex flex-col gap-4 border-b border-zinc-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#111111] sm:text-3xl">
            Einstellungen
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            Team-Bereich für Foto-Upload, Ordner-Automatik und Beamer-Kiosk.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void onLogout()}
          className="flex min-h-[40px] items-center gap-1.5 self-start whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-3.5 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-[#111111] sm:self-auto"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Abmelden</span>
        </button>
      </section>

      {/* Segmented Settings Tabs */}
      <div
        role="tablist"
        aria-label="Einstellungsbereiche"
        className="mt-6 inline-flex flex-wrap items-center gap-1 rounded-xl bg-zinc-200/70 p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'upload'}
          onClick={() => setActiveTab('upload')}
          className={`min-h-[38px] whitespace-nowrap rounded-lg px-4 py-1.5 text-xs font-medium transition-colors ${
            activeTab === 'upload'
              ? 'bg-white text-[#111111] shadow-xs'
              : 'text-zinc-600 hover:text-[#111111]'
          }`}
        >
          Upload &amp; Ordner
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'kiosk'}
          onClick={() => setActiveTab('kiosk')}
          className={`min-h-[38px] whitespace-nowrap rounded-lg px-4 py-1.5 text-xs font-medium transition-colors ${
            activeTab === 'kiosk'
              ? 'bg-white text-[#111111] shadow-xs'
              : 'text-zinc-600 hover:text-[#111111]'
          }`}
        >
          Beamer-Kiosk
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'cloudflare'}
          onClick={() => setActiveTab('cloudflare')}
          className={`min-h-[38px] whitespace-nowrap rounded-lg px-4 py-1.5 text-xs font-medium transition-colors ${
            activeTab === 'cloudflare'
              ? 'bg-white text-[#111111] shadow-xs'
              : 'text-zinc-600 hover:text-[#111111]'
          }`}
        >
          Cloudflare-Setup
        </button>
      </div>

      {/* Tab 1: Upload, Auto Folder Watcher & Active Photos */}
      {activeTab === 'upload' && (
        <div className="mt-8 space-y-8">
          {/* Automatic Camera Folder Watcher (Mac & Windows) */}
          <FolderWatcherPanel
            teamToken={teamToken!}
            onPhotoUploaded={onPhotoUploaded}
            onAuthExpired={onLogout}
            onNotify={onNotify}
          />

          {/* Manual Upload & Camera */}
          <section>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center transition-colors ${
                isDragging
                  ? 'border-[#2563EB] bg-[#2563EB]/[0.04]'
                  : 'border-zinc-300 bg-white hover:border-zinc-400'
              }`}
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 text-[#111111]">
                <Upload className="h-5 w-5" aria-hidden="true" />
              </div>

              <h2 className="mt-3.5 text-base font-semibold text-[#111111]">
                Einzelne Fotos manuell hochladen
              </h2>
              <p className="mt-1 text-xs text-zinc-500">
                JPEG, PNG oder WebP · bis 15 MB · volle Originalauflösung · 5 Min. sichtbar
              </p>

              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="min-h-[42px] whitespace-nowrap rounded-lg bg-[#2563EB] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#1D4ED8]"
                >
                  Dateien auswählen
                </button>

                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex min-h-[42px] items-center gap-2 whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-[#111111] transition-colors hover:bg-zinc-50"
                >
                  <Camera className="h-4 w-4" aria-hidden="true" />
                  <span>Kamera öffnen</span>
                </button>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={handleFileChange}
                className="hidden"
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>

            {queue.length > 0 && (
              <ul className="mt-4 divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white">
                {queue.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs"
                  >
                    <span className="truncate font-medium text-[#111111]">{item.name}</span>
                    <span
                      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap ${
                        item.status === 'error'
                          ? 'text-red-700'
                          : item.status === 'done'
                            ? 'text-zinc-600'
                            : 'text-[#2563EB]'
                      }`}
                    >
                      {item.status === 'done' && (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      <span>
                        {item.status === 'uploading'
                          ? 'Lädt hoch …'
                          : item.message || 'Hochgeladen'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Active Photos Quick Moderation */}
          <section>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-[#111111]">
                Aktive Aufnahmen verwalten
              </h2>
              <p className="font-mono text-xs tabular-nums text-zinc-500">
                {photos.length} / {maxPhotos} Plätze belegt
              </p>
            </div>

            {photos.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500">
                Aktuell sind keine Fotos aktiv. Sobald Bilder hochgeladen werden, kannst du sie
                hier bei Bedarf sofort vorzeitig entfernen.
              </p>
            ) : (
              <div className="mt-3 divide-y divide-zinc-200 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                {photos.map((photo) => {
                  const remainingMs = Math.max(0, photo.expiresAt - serverNow);
                  return (
                    <div
                      key={photo.id}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <div className="flex min-w-0 items-center gap-3.5">
                        <img
                          src={getPhotoUrl(photo.id)}
                          alt={`Vorschau ${photo.fileName}`}
                          referrerPolicy="no-referrer"
                          className="h-12 w-16 shrink-0 rounded-lg bg-zinc-100 object-cover"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-[#111111]">
                            {formatTimeOfDay(photo.createdAt)} Uhr
                          </p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                            <span className="font-mono tabular-nums">
                              Noch {formatCountdown(remainingMs)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {formatFileSize(photo.sizeBytes)}
                            </span>
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={deletingId === photo.id}
                        onClick={() => void handleDelete(photo.id)}
                        className="flex min-h-[38px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Sofort löschen</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Tab 2: Beamer Kiosk Mode */}
      {activeTab === 'kiosk' && (
        <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#111111] text-white">
            <Monitor className="h-5 w-5" aria-hidden="true" />
          </div>

          <h2 className="mt-5 text-xl font-semibold tracking-tight text-[#111111]">
            Beamer-Kiosk-Modus (Dunkel)
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600">
            Zeigt im Vollbild auf tiefschwarzem Hintergrund ausschließlich die letzten 2 oder 3
            aktiven Fotos sauber geordnet — ohne Texte, Menüs oder Countdowns. Neue Aufnahmen
            rücken automatisch nach, abgelaufene Fotos verschwinden weich.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span>Tasten im Kiosk:</span>
            <span className="font-mono text-[#111111]">2</span>
            <span>oder</span>
            <span className="font-mono text-[#111111]">3</span>
            <span>für Anzahl</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-[#111111]">F</span>
            <span>Vollbild</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-[#111111]">ESC</span>
            <span>Beenden</span>
          </div>

          <div className="mt-6">
            <button
              type="button"
              onClick={onLaunchKiosk}
              className="min-h-[44px] whitespace-nowrap rounded-lg bg-[#111111] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#2563EB]"
            >
              Beamer-Kiosk jetzt starten
            </button>
          </div>
        </section>
      )}

      {/* Tab 3: Cloudflare Pages + R2 + D1 Setup */}
      {activeTab === 'cloudflare' && (
        <div className="mt-8">
          <CloudflareGuideView embedded />
        </div>
      )}
    </main>
  );
}
