import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Pause, Play, Square } from 'lucide-react';
import type { PhotoMeta } from '../types/photo';

// Minimal TypeScript declarations for the File System Access API (Chrome / Edge on Mac & Windows)
interface FSFileHandleLike {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
}

interface FSDirectoryHandleLike {
  kind: 'directory';
  name: string;
  entries: () => AsyncIterableIterator<[string, FSFileHandleLike | { kind: 'directory'; name: string }]>;
  removeEntry: (name: string) => Promise<void>;
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }) => Promise<FSDirectoryHandleLike>;
};

interface FolderWatcherPanelProps {
  teamToken: string;
  onPhotoUploaded: (photo: PhotoMeta, serverTime?: number) => void;
  onAuthExpired: () => Promise<void>;
  onNotify: (message: string, tone?: 'info' | 'error') => void;
}

interface WatcherLogEntry {
  id: string;
  fileName: string;
  time: string;
  status: 'uploaded_deleted' | 'uploaded_kept' | 'error';
  detail: string;
}

interface PendingStability {
  size: number;
  lastModified: number;
  stableTicks: number;
}

const IMAGE_EXT_REGEX = /\.(jpe?g|png|webp)$/i;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

function buildStandaloneWatcherScript(originUrl: string): string {
  return `#!/usr/bin/env node
/**
 * Fotobox Ordner-Watcher (Mac & Windows)
 * Überwacht einen lokalen Kamera-Ordner, lädt neue Fotos (JPEG/PNG/WebP)
 * in voller Originalqualität hoch und löscht sie nach erfolgreichem Upload.
 *
 * Nutzung (Node.js 18+ erforderlich, keine Pakete nötig):
 *   node fotobox-watcher.mjs "./kamera-ordner" "${originUrl}" "DEINE_TEAM_PIN"
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const [, , watchDirArg, baseUrlArg, pinArg] = process.argv;

if (!watchDirArg || !baseUrlArg || !pinArg) {
  console.error('Nutzung: node fotobox-watcher.mjs <ORDNER_PFAD> <WEBSEITEN_URL> <TEAM_PIN>');
  process.exit(1);
}

const WATCH_DIR = path.resolve(watchDirArg);
const BASE_URL = baseUrlArg.replace(/\\/+$/, '');
const PIN = pinArg.trim();
const IMAGE_REGEX = /\\.(jpe?g|png|webp)$/i;
const MAX_BYTES = 15 * 1024 * 1024;

let token = null;
const stabilityMap = new Map();
const inFlight = new Set();

async function login() {
  const res = await fetch(\`\${BASE_URL}/api/auth/login\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) {
    throw new Error(data.error || 'Team-PIN Anmeldung fehlgeschlagen.');
  }
  token = data.token;
  console.log('Mit Team-PIN angemeldet.');
}

function guessMime(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

async function uploadAndDelete(fileName) {
  const fullPath = path.join(WATCH_DIR, fileName);
  inFlight.add(fileName);
  try {
    const buffer = await fs.readFile(fullPath);
    if (buffer.length === 0 || buffer.length > MAX_BYTES) {
      console.warn(\`Übersprungen (\${fileName}): ungültige Dateigröße (\${buffer.length} Bytes)\`);
      return;
    }

    const form = new FormData();
    form.append('photo', new Blob([buffer], { type: guessMime(fileName) }), fileName);

    let res = await fetch(\`\${BASE_URL}/api/photos\`, {
      method: 'POST',
      headers: { Authorization: \`Bearer \${token}\` },
      body: form,
    });

    if (res.status === 401) {
      await login();
      res = await fetch(\`\${BASE_URL}/api/photos\`, {
        method: 'POST',
        headers: { Authorization: \`Bearer \${token}\` },
        body: form,
      });
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || \`HTTP \${res.status}\`);
    }

    await fs.unlink(fullPath);
    stabilityMap.delete(fileName);
    console.log(\`[\${new Date().toLocaleTimeString('de-DE')}] Hochgeladen & lokal gelöscht: \${fileName}\`);
  } catch (err) {
    console.error(\`Fehler bei \${fileName} (Datei bleibt erhalten):\`, err.message);
  } finally {
    inFlight.delete(fileName);
  }
}

async function scan() {
  const entries = await fs.readdir(WATCH_DIR, { withFileTypes: true });
  const activeNames = new Set();

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !IMAGE_REGEX.test(entry.name)) continue;
    activeNames.add(entry.name);
    if (inFlight.has(entry.name)) continue;

    const stat = await fs.stat(path.join(WATCH_DIR, entry.name)).catch(() => null);
    if (!stat || stat.size === 0) continue;

    const prev = stabilityMap.get(entry.name);
    if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
      await uploadAndDelete(entry.name);
    } else {
      stabilityMap.set(entry.name, { size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  for (const known of stabilityMap.keys()) {
    if (!activeNames.has(known)) stabilityMap.delete(known);
  }
}

await login();
console.log(\`Überwache Ordner: \${WATCH_DIR} (Strg+C zum Beenden)\`);
setInterval(() => {
  scan().catch((err) => console.error('Scan-Fehler:', err.message));
}, 1500);
`;
}

export function FolderWatcherPanel({
  teamToken,
  onPhotoUploaded,
  onAuthExpired,
  onNotify,
}: FolderWatcherPanelProps) {
  const [dirHandle, setDirHandle] = useState<FSDirectoryHandleLike | null>(null);
  const [watching, setWatching] = useState<boolean>(false);
  const [deleteAfterUpload, setDeleteAfterUpload] = useState<boolean>(true);
  const [uploadedCount, setUploadedCount] = useState<number>(0);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [logs, setLogs] = useState<WatcherLogEntry[]>([]);

  const stabilityRef = useRef<Map<string, PendingStability>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const uploadedWithoutDeleteRef = useRef<Set<string>>(new Set());
  const scanningRef = useRef<boolean>(false);

  const supportsDirectoryPicker =
    typeof window !== 'undefined' &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';

  const appendLog = useCallback((entry: Omit<WatcherLogEntry, 'id' | 'time'>) => {
    const time = new Intl.DateTimeFormat('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());

    setLogs((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        time,
        ...entry,
      },
      ...prev.slice(0, 7),
    ]);
  }, []);

  const handleSelectFolder = async () => {
    setPickerError(null);
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      setPickerError(
        'Dieser Browser unterstützt den direkten Ordner-Zugriff nicht. Bitte Chrome oder Edge auf Mac/Windows verwenden oder unten das Hintergrund-Skript laden.',
      );
      return;
    }

    try {
      const handle = await picker({
        id: 'fotobox-watch-folder',
        mode: deleteAfterUpload ? 'readwrite' : 'read',
      });

      if (deleteAfterUpload && handle.requestPermission) {
        const perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          setPickerError(
            'Schreib-/Löschberechtigung für den Ordner wurde nicht erteilt. Ohne diese Freigabe können Dateien nach dem Upload nicht automatisch gelöscht werden.',
          );
          return;
        }
      }

      stabilityRef.current.clear();
      inFlightRef.current.clear();
      uploadedWithoutDeleteRef.current.clear();
      setDirHandle(handle);
      setWatching(true);
      onNotify(`Ordner „${handle.name}“ wird jetzt automatisch überwacht.`);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      if (err instanceof Error && err.name === 'SecurityError') {
        setPickerError(
          'In einer eingebetteten Vorschau blockiert der Browser den lokalen Ordner-Zugriff. Öffne die Webseite direkt in einem normalen Chrome- oder Edge-Tab (oder nutze das Mac/Windows-Skript unten).',
        );
        return;
      }
      setPickerError(
        err instanceof Error ? err.message : 'Ordner konnte nicht geöffnet werden.',
      );
    }
  };

  const handleStopWatching = () => {
    setWatching(false);
    setDirHandle(null);
    stabilityRef.current.clear();
    inFlightRef.current.clear();
    uploadedWithoutDeleteRef.current.clear();
    onNotify('Ordner-Überwachung beendet.');
  };

  const handleDownloadWatcherScript = () => {
    const content = buildStandaloneWatcherScript(window.location.origin);
    const blob = new Blob([content], { type: 'text/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fotobox-watcher.mjs';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    onNotify('fotobox-watcher.mjs heruntergeladen.');
  };

  useEffect(() => {
    if (!dirHandle || !watching) return;

    let cancelled = false;

    const scanFolder = async () => {
      if (cancelled || scanningRef.current) return;
      scanningRef.current = true;

      try {
        const seenNames = new Set<string>();

        for await (const [entryName, entry] of dirHandle.entries()) {
          if (cancelled) break;
          if (entry.kind !== 'file') continue;
          if (entryName.startsWith('.') || !IMAGE_EXT_REGEX.test(entryName)) continue;

          seenNames.add(entryName);

          if (inFlightRef.current.has(entryName)) continue;

          let file: File;
          try {
            file = await entry.getFile();
          } catch {
            continue;
          }

          if (file.size === 0) continue;

          const signature = `${entryName}:${file.size}:${file.lastModified}`;
          if (!deleteAfterUpload && uploadedWithoutDeleteRef.current.has(signature)) {
            continue;
          }

          if (file.size > MAX_FILE_BYTES) {
            stabilityRef.current.delete(entryName);
            uploadedWithoutDeleteRef.current.add(signature);
            appendLog({
              fileName: entryName,
              status: 'error',
              detail: 'Übersprungen (> 15 MB)',
            });
            continue;
          }

          // Wait until file size & modified time are stable across two scans (camera finished writing)
          const prev = stabilityRef.current.get(entryName);
          if (!prev || prev.size !== file.size || prev.lastModified !== file.lastModified) {
            stabilityRef.current.set(entryName, {
              size: file.size,
              lastModified: file.lastModified,
              stableTicks: 0,
            });
            continue;
          }

          // File is stable -> upload now!
          inFlightRef.current.add(entryName);
          try {
            const formData = new FormData();
            formData.append('photo', file, entryName);

            const response = await fetch('/api/photos', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${teamToken}`,
              },
              body: formData,
            });

            const data = (await response.json().catch(() => ({}))) as {
              photo?: PhotoMeta;
              serverNow?: number;
              error?: string;
            };

            if (response.status === 401) {
              setWatching(false);
              await onAuthExpired();
              return;
            }

            if (!response.ok || !data.photo) {
              throw new Error(data.error || `HTTP ${response.status}`);
            }

            onPhotoUploaded(data.photo, data.serverNow);
            setUploadedCount((count) => count + 1);
            stabilityRef.current.delete(entryName);

            if (deleteAfterUpload) {
              try {
                await dirHandle.removeEntry(entryName);
                appendLog({
                  fileName: entryName,
                  status: 'uploaded_deleted',
                  detail: 'Hochgeladen & lokal gelöscht',
                });
              } catch {
                uploadedWithoutDeleteRef.current.add(signature);
                appendLog({
                  fileName: entryName,
                  status: 'uploaded_kept',
                  detail: 'Hochgeladen (Löschrecht fehlt)',
                });
              }
            } else {
              uploadedWithoutDeleteRef.current.add(signature);
              appendLog({
                fileName: entryName,
                status: 'uploaded_kept',
                detail: 'Hochgeladen (lokal behalten)',
              });
            }
          } catch (err) {
            appendLog({
              fileName: entryName,
              status: 'error',
              detail:
                err instanceof Error
                  ? `${err.message} (Datei bleibt erhalten)`
                  : 'Upload fehlgeschlagen',
            });
          } finally {
            inFlightRef.current.delete(entryName);
          }
        }

        // Clean up stability entries for removed files
        for (const trackedName of stabilityRef.current.keys()) {
          if (!seenNames.has(trackedName)) {
            stabilityRef.current.delete(trackedName);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setWatching(false);
          setPickerError(
            err instanceof Error
              ? `Ordner-Zugriff unterbrochen: ${err.message}`
              : 'Ordner-Zugriff wurde unterbrochen.',
          );
        }
      } finally {
        scanningRef.current = false;
      }
    };

    void scanFolder();
    const intervalId = window.setInterval(() => {
      void scanFolder();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    appendLog,
    deleteAfterUpload,
    dirHandle,
    onAuthExpired,
    onPhotoUploaded,
    teamToken,
    watching,
  ]);

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xl">
          <h2 className="text-base font-semibold text-[#111111]">
            Automatischer Ordner-Upload (Mac &amp; Windows)
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-600">
            Wähle den Ausgabeordner eurer Kamera oder Fotobox in Chrome oder Edge aus. Neue
            Fotos werden automatisch in voller Qualität hochgeladen und nach Bestätigung
            sofort aus dem Ordner gelöscht.
          </p>
        </div>

        <button
          type="button"
          onClick={handleDownloadWatcherScript}
          className="flex min-h-[38px] shrink-0 items-center gap-1.5 self-start whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
        >
          <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Hintergrund-Skript (.mjs)</span>
        </button>
      </div>

      {/* Delete-after-upload toggle */}
      <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-xs text-zinc-700">
        <input
          type="checkbox"
          checked={deleteAfterUpload}
          disabled={Boolean(dirHandle)}
          onChange={(e) => setDeleteAfterUpload(e.target.checked)}
          className="h-4 w-4 rounded border-zinc-300 text-[#2563EB] focus:ring-[#2563EB]"
        />
        <span>
          Lokale Bilddatei nach erfolgreichem Upload automatisch aus dem Ordner löschen
        </span>
      </label>

      {/* Active Watcher Controls */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {!dirHandle ? (
          <button
            type="button"
            onClick={() => void handleSelectFolder()}
            className="flex min-h-[42px] items-center gap-2 whitespace-nowrap rounded-lg bg-[#111111] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#2563EB]"
          >
            <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Kamera-Ordner auswählen</span>
          </button>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-zinc-700">
              <span className="font-medium text-[#111111]">Ordner: {dirHandle.name}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-zinc-600">
                {watching ? 'Aktiv' : 'Pausiert'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-zinc-600">
                {uploadedCount} übertragen
              </span>
            </div>

            <div className="flex items-center gap-2 sm:ml-auto">
              <button
                type="button"
                onClick={() => setWatching((prev) => !prev)}
                className="flex min-h-[38px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-[#111111] transition-colors hover:bg-zinc-50"
              >
                {watching ? (
                  <>
                    <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Pausieren</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Fortsetzen</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleStopWatching}
                className="flex min-h-[38px] items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700"
              >
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Trennen</span>
              </button>
            </div>
          </>
        )}

        {!supportsDirectoryPicker && !pickerError && (
          <p className="text-xs text-zinc-500">
            Direkter Ordner-Zugriff erfordert Chrome oder Edge — alternativ das Skript
            herunterladen.
          </p>
        )}
      </div>

      {pickerError && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900"
        >
          {pickerError}
        </p>
      )}

      {/* Recent automated uploads */}
      {logs.length > 0 && (
        <ul className="mt-5 divide-y divide-zinc-100 rounded-xl border border-zinc-200/80 bg-[#FAFAFA]">
          {logs.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="shrink-0 font-mono tabular-nums text-zinc-400">
                  {item.time}
                </span>
                <span className="truncate font-medium text-[#111111]">{item.fileName}</span>
              </div>
              <span
                className={`shrink-0 whitespace-nowrap ${
                  item.status === 'error' ? 'text-red-700' : 'text-zinc-600'
                }`}
              >
                {item.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
