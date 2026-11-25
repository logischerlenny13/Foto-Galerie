import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Privacy & capacity limits
const PHOTO_TTL_MS = 5 * 60 * 1000; // Exakt 5 Minuten
const MAX_ACTIVE_PHOTOS = 30; // Maximal 30 Fotos gleichzeitig (älteste werden ersetzt)
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB pro Foto (volle Originalqualität)
const MAX_TOTAL_MEMORY_BYTES = 250 * 1024 * 1024; // 250 MB RAM-Schutzlimit
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 Stunden Team-Sitzung

interface StoredPhoto {
  id: string;
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  fileName: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

interface PhotoMeta {
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

interface PinHashRecord {
  saltHex: string;
  hashHex: string;
}

interface SessionRecord {
  createdAt: number;
  expiresAt: number;
}

interface LoginAttemptRecord {
  count: number;
  windowStart: number;
}

// Flüchtiger Arbeitsspeicher (RAM-Only — keine Dateien auf der Festplatte)
const photos = new Map<string, StoredPhoto>();
const sessions = new Map<string, SessionRecord>();
const loginAttempts = new Map<string, LoginAttemptRecord>();
let claimedPinHash: PinHashRecord | null = null;
let totalPhotoBytes = 0;

// WebSocket clients
const wsClients = new Set<WebSocket>();

function getEnvPin(): string | null {
  const raw = process.env.UPLOAD_PIN?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function isPinConfigured(): boolean {
  return Boolean(getEnvPin() || claimedPinHash);
}

function hashPin(pin: string, saltHex?: string): PinHashRecord {
  const salt = saltHex ?? crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin, salt, 64).toString('hex');
  return { saltHex: salt, hashHex: derived };
}

function timingSafeStringMatch(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function verifyPin(candidate: string): boolean {
  const envPin = getEnvPin();
  if (envPin) {
    return timingSafeStringMatch(candidate, envPin);
  }
  if (!claimedPinHash) {
    return false;
  }
  const computed = hashPin(candidate, claimedPinHash.saltHex);
  const expectedBuf = Buffer.from(claimedPinHash.hashHex, 'hex');
  const computedBuf = Buffer.from(computed.hashHex, 'hex');
  if (expectedBuf.length !== computedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, computedBuf);
}

function createSession(): { token: string; expiresInMs: number } {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, {
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return { token, expiresInMs: SESSION_TTL_MS };
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function isValidSession(token: string | null): boolean {
  if (!token) return false;
  const record = sessions.get(token);
  if (!record) return false;
  if (Date.now() > record.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireTeamAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!isValidSession(token)) {
    res.status(401).json({ error: 'Bitte zuerst mit der Team-PIN anmelden.' });
    return;
  }
  next();
}

function checkLoginThrottle(ip: string): boolean {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxAttempts = 12;
  const existing = loginAttempts.get(ip);
  if (!existing || now - existing.windowStart > windowMs) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= maxAttempts) {
    return false;
  }
  existing.count += 1;
  return true;
}

// Magic-byte validation: only allow real JPEG, PNG, or WebP binaries
function detectImageMimeType(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

// Lightweight header-only dimension parser (no native dependencies, lossless)
function parseImageDimensions(
  buf: Buffer,
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
): { width: number | null; height: number | null } {
  try {
    if (mimeType === 'image/png' && buf.length >= 24) {
      return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
      };
    }

    if (mimeType === 'image/jpeg') {
      let offset = 2;
      while (offset + 8 < buf.length) {
        if (buf[offset] !== 0xff) break;
        const marker = buf[offset + 1];
        // Skip padding bytes
        if (marker === 0xff) {
          offset += 1;
          continue;
        }
        // Start Of Frame markers (SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15)
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          const height = buf.readUInt16BE(offset + 5);
          const width = buf.readUInt16BE(offset + 7);
          return { width, height };
        }
        if (offset + 4 > buf.length) break;
        const segmentLength = buf.readUInt16BE(offset + 2);
        if (segmentLength < 2) break;
        offset += 2 + segmentLength;
      }
    }

    if (mimeType === 'image/webp' && buf.length >= 30) {
      const chunkHeader = buf.toString('ascii', 12, 16);
      if (chunkHeader === 'VP8X') {
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width, height };
      }
      if (chunkHeader === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        return { width, height };
      }
      if (chunkHeader === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        return { width, height };
      }
    }
  } catch {
    // Dimensions are optional metadata; ignore malformed headers
  }
  return { width: null, height: null };
}

function buildSafeFileName(mimeType: 'image/jpeg' | 'image/png' | 'image/webp', createdAt: number): string {
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const date = new Date(createdAt);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `tag-der-offenen-tuer-${hh}${mm}${ss}.${ext}`;
}

function toPhotoMeta(photo: StoredPhoto, now = Date.now()): PhotoMeta {
  return {
    id: photo.id,
    fileName: photo.fileName,
    mimeType: photo.mimeType,
    sizeBytes: photo.sizeBytes,
    width: photo.width,
    height: photo.height,
    createdAt: photo.createdAt,
    expiresAt: photo.expiresAt,
    remainingMs: Math.max(0, photo.expiresAt - now),
  };
}

function getOrderedPhotos(now = Date.now()): PhotoMeta[] {
  const active: StoredPhoto[] = [];
  for (const photo of photos.values()) {
    if (photo.expiresAt > now) {
      active.push(photo);
    }
  }
  active.sort((a, b) => b.createdAt - a.createdAt);
  return active.map((item) => toPhotoMeta(item, now));
}

function broadcastEvent(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(serialized);
    }
  }
}

function removePhoto(id: string, reason: 'ttl' | 'limit' | 'manual'): boolean {
  const existing = photos.get(id);
  if (!existing) return false;

  clearTimeout(existing.timer);
  photos.delete(id);
  totalPhotoBytes = Math.max(0, totalPhotoBytes - existing.sizeBytes);

  broadcastEvent({
    type: 'photo:expired',
    serverNow: Date.now(),
    id,
    reason,
  });
  return true;
}

function evictOldestIfNeeded(incomingBytes: number): void {
  // Always keep <= MAX_ACTIVE_PHOTOS - 1 before adding a new photo, and respect RAM cap
  while (
    photos.size >= MAX_ACTIVE_PHOTOS ||
    (photos.size > 0 && totalPhotoBytes + incomingBytes > MAX_TOTAL_MEMORY_BYTES)
  ) {
    let oldest: StoredPhoto | null = null;
    for (const candidate of photos.values()) {
      if (!oldest || candidate.createdAt < oldest.createdAt) {
        oldest = candidate;
      }
    }
    if (!oldest) break;
    removePhoto(oldest.id, 'limit');
  }
}

function purgeExpiredPhotos(): void {
  const now = Date.now();
  for (const photo of photos.values()) {
    if (photo.expiresAt <= now) {
      removePhoto(photo.id, 'ttl');
    }
  }
}

// Safety sweep every 5 seconds in addition to exact per-photo timers
const sweepTimer = setInterval(purgeExpiredPhotos, 5000);
sweepTimer.unref();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
});

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  // Health & config
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      ttlMs: PHOTO_TTL_MS,
      maxPhotos: MAX_ACTIVE_PHOTOS,
      activePhotos: photos.size,
      serverNow: Date.now(),
    });
  });

  // Auth status
  app.get('/api/auth/status', (req: Request, res: Response) => {
    const token = extractBearerToken(req);
    const authenticated = isValidSession(token);
    res.json({
      configured: isPinConfigured(),
      envManaged: Boolean(getEnvPin()),
      authenticated,
    });
  });

  // One-time in-app PIN setup when UPLOAD_PIN env var is not configured
  app.post('/api/auth/setup', (req: Request, res: Response) => {
    if (getEnvPin()) {
      res.status(403).json({ error: 'Die Upload-PIN wird über die Server-Konfiguration verwaltet.' });
      return;
    }
    if (claimedPinHash) {
      res.status(403).json({ error: 'Die Upload-PIN wurde bereits eingerichtet.' });
      return;
    }

    const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
    if (pin.length < 4 || pin.length > 32) {
      res.status(400).json({ error: 'Bitte eine PIN mit 4 bis 32 Zeichen wählen.' });
      return;
    }

    claimedPinHash = hashPin(pin);
    const session = createSession();
    res.status(201).json({
      token: session.token,
      expiresInMs: session.expiresInMs,
      configured: true,
    });
  });

  // Team PIN login
  app.post('/api/auth/login', (req: Request, res: Response) => {
    if (!isPinConfigured()) {
      res.status(409).json({ error: 'Bitte zuerst eine Upload-PIN einrichten.' });
      return;
    }

    const clientIp = req.ip || 'unknown';
    if (!checkLoginThrottle(clientIp)) {
      res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte in 5 Minuten erneut versuchen.' });
      return;
    }

    const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
    if (!pin || !verifyPin(pin)) {
      res.status(401).json({ error: 'Die eingegebene Team-PIN ist nicht korrekt.' });
      return;
    }

    loginAttempts.delete(clientIp);
    const session = createSession();
    res.json({
      token: session.token,
      expiresInMs: session.expiresInMs,
    });
  });

  // Logout
  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const token = extractBearerToken(req);
    if (token) {
      sessions.delete(token);
    }
    res.json({ ok: true });
  });

  // List currently active photos (newest first)
  app.get('/api/photos', (_req: Request, res: Response) => {
    purgeExpiredPhotos();
    const now = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      serverNow: now,
      ttlMs: PHOTO_TTL_MS,
      maxPhotos: MAX_ACTIVE_PHOTOS,
      photos: getOrderedPhotos(now),
    });
  });

  // Upload a new photo in full original quality (PIN session required)
  app.post(
    '/api/photos',
    requireTeamAuth,
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('photo')(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'Das Foto ist größer als 15 MB.' });
          return;
        }
        if (err) {
          res.status(400).json({ error: 'Upload konnte nicht verarbeitet werden.' });
          return;
        }
        next();
      });
    },
    (req: Request, res: Response) => {
      purgeExpiredPhotos();

      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        res.status(400).json({ error: 'Bitte eine Bilddatei auswählen.' });
        return;
      }

      const detectedMime = detectImageMimeType(file.buffer);
      if (!detectedMime) {
        res.status(400).json({ error: 'Nur JPEG-, PNG- oder WebP-Fotos werden unterstützt.' });
        return;
      }

      evictOldestIfNeeded(file.buffer.length);

      const id = crypto.randomUUID();
      const createdAt = Date.now();
      const expiresAt = createdAt + PHOTO_TTL_MS;
      const { width, height } = parseImageDimensions(file.buffer, detectedMime);
      const fileName = buildSafeFileName(detectedMime, createdAt);

      const timer = setTimeout(() => {
        removePhoto(id, 'ttl');
      }, PHOTO_TTL_MS);
      timer.unref();

      const stored: StoredPhoto = {
        id,
        buffer: file.buffer,
        mimeType: detectedMime,
        fileName,
        sizeBytes: file.buffer.length,
        width,
        height,
        createdAt,
        expiresAt,
        timer,
      };

      photos.set(id, stored);
      totalPhotoBytes += stored.sizeBytes;

      const meta = toPhotoMeta(stored, createdAt);

      broadcastEvent({
        type: 'photo:created',
        serverNow: createdAt,
        photo: meta,
      });

      res.status(201).json({
        serverNow: createdAt,
        photo: meta,
      });
    },
  );

  // Stream original photo file without compression or browser caching
  app.get('/api/photos/:id/file', (req: Request, res: Response) => {
    purgeExpiredPhotos();
    const id = req.params.id;
    const photo = photos.get(id);
    if (!photo || Date.now() >= photo.expiresAt) {
      if (photo) removePhoto(id, 'ttl');
      res.status(404).json({ error: 'Dieses Foto ist bereits abgelaufen und wurde gelöscht.' });
      return;
    }

    const forceDownload = req.query.download === '1';
    const disposition = forceDownload ? 'attachment' : 'inline';

    res.setHeader('Content-Type', photo.mimeType);
    res.setHeader('Content-Length', String(photo.sizeBytes));
    res.setHeader('Content-Disposition', `${disposition}; filename="${photo.fileName}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(photo.buffer);
  });

  // Immediate manual delete by team member
  app.delete('/api/photos/:id', requireTeamAuth, (req: Request, res: Response) => {
    const removed = removePhoto(req.params.id, 'manual');
    if (!removed) {
      res.status(404).json({ error: 'Foto wurde nicht gefunden oder ist bereits gelöscht.' });
      return;
    }
    res.json({ ok: true, id: req.params.id });
  });

  // Mount Vite dev middleware or serve static dist in production
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir, { index: false }));
    app.get('*', (_req: Request, res: Response) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(503).send('Build fehlt. Bitte zuerst npm run build ausführen.');
      }
    });
  }

  const server = http.createServer(app);

  // Attach real-time WebSocket hub on the same port (3000)
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket: WebSocket) => {
    wsClients.add(socket);
    purgeExpiredPhotos();
    const now = Date.now();
    socket.send(
      JSON.stringify({
        type: 'init',
        serverNow: now,
        ttlMs: PHOTO_TTL_MS,
        maxPhotos: MAX_ACTIVE_PHOTOS,
        photos: getOrderedPhotos(now),
      }),
    );

    socket.on('close', () => {
      wsClients.delete(socket);
    });

    socket.on('error', () => {
      wsClients.delete(socket);
    });
  });

  // Keepalive ping every 30s to clean stale sockets
  const heartbeat = setInterval(() => {
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      } else {
        wsClients.delete(client);
      }
    }
  }, 30000);
  heartbeat.unref();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Tag der offenen Tür Server läuft auf http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Serverstart fehlgeschlagen:', err);
  process.exit(1);
});
