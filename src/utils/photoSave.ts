import type { PhotoMeta } from '../types/photo';

export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

export function isMobileDevice(): boolean {
  return isIOSDevice() || isAndroidDevice();
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatTimeOfDay(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

export function getPhotoUrl(id: string): string {
  return `/api/photos/${encodeURIComponent(id)}/file`;
}

export function getDownloadUrl(id: string): string {
  return `/api/photos/${encodeURIComponent(id)}/file?download=1`;
}

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * Saves the photo in full original quality (zero re-encoding).
 * - On iOS (and mobile browsers supporting Web Share API with files):
 *   opens the native Share Sheet with the untouched original file so
 *   "Bild sichern" saves straight into Apple Photos (or Android Photos).
 * - On desktop or browsers without file sharing: triggers direct download.
 */
export async function savePhotoToLibrary(photo: PhotoMeta): Promise<SaveOutcome> {
  const response = await fetch(getPhotoUrl(photo.id), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Dieses Foto ist bereits abgelaufen und wurde gelöscht.');
  }

  const blob = await response.blob();
  const file = new File([blob], photo.fileName, {
    type: photo.mimeType || blob.type || 'image/jpeg',
  });

  const canShareFiles =
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] });

  // Prefer native Web Share on mobile (iOS -> "Bild sichern" directly into Apple Photos; Android -> Gallery/Photos share)
  if (canShareFiles && isMobileDevice()) {
    try {
      await navigator.share({
        files: [file],
        title: 'Tag der offenen Tür',
      });
      return 'shared';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Fall through to direct download if share failed
    }
  }

  triggerBlobDownload(blob, photo.fileName);
  return 'downloaded';
}

export async function downloadOriginalPhoto(photo: PhotoMeta): Promise<void> {
  const response = await fetch(getDownloadUrl(photo.id), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Dieses Foto ist bereits abgelaufen und wurde gelöscht.');
  }
  const blob = await response.blob();
  triggerBlobDownload(blob, photo.fileName);
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
}
