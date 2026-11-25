export type ViewMode = 'gallery' | 'settings' | 'kiosk' | 'privacy';

export type SettingsTab = 'upload' | 'kiosk' | 'cloudflare';

export interface PhotoMeta {
  id: string;
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: number;
  expiresAt: number;
  remainingMs: number;
}

export interface AuthStatus {
  configured: boolean;
  envManaged: boolean;
  authenticated: boolean;
}

export type LiveSocketEvent =
  | {
      type: 'init';
      serverNow: number;
      ttlMs: number;
      maxPhotos: number;
      photos: PhotoMeta[];
    }
  | {
      type: 'photo:created';
      serverNow: number;
      photo: PhotoMeta;
    }
  | {
      type: 'photo:expired';
      serverNow: number;
      id: string;
      reason: 'ttl' | 'limit' | 'manual';
    };
