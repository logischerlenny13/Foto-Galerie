// Cloudflare Pages Functions Backend für Tag der offenen Tür
// Nutzt Cloudflare R2 (PHOTOS_BUCKET) für Originalfotos + Cloudflare D1 (DB) für Metadaten.
// Erzwingt automatisch 5-Minuten-Datenschutzlöschung UND das 30-Foto-Rollover-Limit.

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface R2ObjectBody {
  body: ReadableStream;
  size: number;
}

interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
}

interface Env {
  DB: D1Database;
  PHOTOS_BUCKET: R2Bucket;
  UPLOAD_PIN?: string;
}

interface PagesContext {
  request: Request;
  env: Env;
  params: { path?: string | string[] };
}

interface PhotoRow {
  id: string;
  r2_key: string;
  file_name: string;
  mime_type: 'image/jpeg' | 'image/png' | 'image/webp';
  size_bytes: number;
  width: number | null;
  height: number | null;
  created_at: number;
  expires_at: number;
}

const PHOTO_TTL_MS = 5 * 60 * 1000; // Exakt 5 Minuten
const MAX_ACTIVE_PHOTOS = 30; // Maximal 30 Fotos (älteste werden ersetzt)
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 Stunden

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return new Uint8Array(digest);
}

async function pbkdf2Hash(pin: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const saltBytes = hexToBytes(saltHex);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes.buffer as ArrayBuffer,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function detectImageMimeType(buf: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
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

function parseImageDimensions(
  buf: Uint8Array,
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp',
): { width: number | null; height: number | null } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    if (mimeType === 'image/png' && buf.length >= 24) {
      return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
    }
    if (mimeType === 'image/jpeg') {
      let offset = 2;
      while (offset + 8 < buf.length) {
        if (buf[offset] !== 0xff) break;
        const marker = buf[offset + 1];
        if (marker === 0xff) {
          offset += 1;
          continue;
        }
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return {
            height: view.getUint16(offset + 5, false),
            width: view.getUint16(offset + 7, false),
          };
        }
        if (offset + 4 > buf.length) break;
        const len = view.getUint16(offset + 2, false);
        if (len < 2) break;
        offset += 2 + len;
      }
    }
    if (mimeType === 'image/webp' && buf.length >= 30) {
      const header = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
      if (header === 'VP8X') {
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width, height };
      }
      if (header === 'VP8 ') {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      }
      if (header === 'VP8L' && buf.length >= 25) {
        const bits = view.getUint32(21, true);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
    }
  } catch {
    // Optional metadata
  }
  return { width: null, height: null };
}

function buildSafeFileName(mimeType: 'image/jpeg' | 'image/png' | 'image/webp', createdAt: number): string {
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const d = new Date(createdAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `tag-der-offenen-tuer-${hh}${mm}${ss}.${ext}`;
}

function toMeta(row: PhotoRow, now: number) {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    remainingMs: Math.max(0, row.expires_at - now),
  };
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function isValidSession(env: Env, token: string | null): Promise<boolean> {
  if (!token) return false;
  const now = Date.now();
  const row = await env.DB.prepare('SELECT token, expires_at FROM sessions WHERE token = ?')
    .bind(token)
    .first<{ token: string; expires_at: number }>();
  if (!row) return false;
  if (row.expires_at <= now) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return false;
  }
  return true;
}

async function createSession(env: Env): Promise<{ token: string; expiresInMs: number }> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const token = bytesToHex(randomBytes);
  const now = Date.now();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .bind(token, now, now + SESSION_TTL_MS)
    .run();
  return { token, expiresInMs: SESSION_TTL_MS };
}

async function getPinStatus(env: Env): Promise<{ configured: boolean; envManaged: boolean; storedHash: string | null }> {
  const envPin = env.UPLOAD_PIN?.trim();
  if (envPin) {
    return { configured: true, envManaged: true, storedHash: null };
  }
  const row = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?')
    .bind('pin_hash')
    .first<{ value: string }>();
  return {
    configured: Boolean(row?.value),
    envManaged: false,
    storedHash: row?.value ?? null,
  };
}

async function verifyPin(env: Env, candidate: string): Promise<boolean> {
  const envPin = env.UPLOAD_PIN?.trim();
  if (envPin) {
    const a = await sha256Bytes(candidate);
    const b = await sha256Bytes(envPin);
    return timingSafeEqualBytes(a, b);
  }
  const status = await getPinStatus(env);
  if (!status.storedHash) return false;
  const [saltHex, expectedHex] = status.storedHash.split(':');
  if (!saltHex || !expectedHex) return false;
  const computedHex = await pbkdf2Hash(candidate, saltHex);
  return timingSafeEqualBytes(hexToBytes(computedHex), hexToBytes(expectedHex));
}

// Deletes all expired photos (> 5 min) from BOTH Cloudflare R2 and Cloudflare D1
async function purgeExpired(env: Env, now: number): Promise<void> {
  const expired = await env.DB.prepare('SELECT id, r2_key FROM photos WHERE expires_at <= ?')
    .bind(now)
    .all<{ id: string; r2_key: string }>();

  if (expired.results.length === 0) return;

  await env.PHOTOS_BUCKET.delete(expired.results.map((r) => r.r2_key));
  await env.DB.prepare('DELETE FROM photos WHERE expires_at <= ?').bind(now).run();
}

// Enforces rolling cap of max 30 photos: deletes oldest photos from R2 + D1 so new ones fit
async function enforceMaxPhotoCap(env: Env): Promise<void> {
  const overflow = await env.DB.prepare(
    'SELECT id, r2_key FROM photos ORDER BY created_at DESC LIMIT -1 OFFSET ?',
  )
    .bind(MAX_ACTIVE_PHOTOS)
    .all<{ id: string; r2_key: string }>();

  if (overflow.results.length === 0) return;

  await env.PHOTOS_BUCKET.delete(overflow.results.map((r) => r.r2_key));
  for (const row of overflow.results) {
    await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(row.id).run();
  }
}

export const onRequest = async (context: PagesContext): Promise<Response> => {
  const { request, env } = context;

  if (!env.DB || !env.PHOTOS_BUCKET) {
    return jsonResponse(
      {
        error:
          'Cloudflare Bindings fehlen: Bitte DB (D1) und PHOTOS_BUCKET (R2) in den Cloudflare Pages Einstellungen verknüpfen.',
      },
      500,
    );
  }

  const url = new URL(request.url);
  const subPath = url.pathname.replace(/^\/api\/?/, '');
  const method = request.method.toUpperCase();
  const now = Date.now();

  // GET /api/health
  if (subPath === 'health' && method === 'GET') {
    await purgeExpired(env, now);
    const countRow = await env.DB.prepare('SELECT COUNT(*) as count FROM photos').first<{ count: number }>();
    return jsonResponse({
      ok: true,
      ttlMs: PHOTO_TTL_MS,
      maxPhotos: MAX_ACTIVE_PHOTOS,
      activePhotos: countRow?.count ?? 0,
      serverNow: now,
    });
  }

  // GET /api/auth/status
  if (subPath === 'auth/status' && method === 'GET') {
    const status = await getPinStatus(env);
    const authenticated = await isValidSession(env, getBearerToken(request));
    return jsonResponse({
      configured: status.configured,
      envManaged: status.envManaged,
      authenticated,
    });
  }

  // POST /api/auth/setup
  if (subPath === 'auth/setup' && method === 'POST') {
    const status = await getPinStatus(env);
    if (status.envManaged) {
      return jsonResponse({ error: 'Die Upload-PIN wird über UPLOAD_PIN verwaltet.' }, 403);
    }
    if (status.configured) {
      return jsonResponse({ error: 'Die Upload-PIN wurde bereits eingerichtet.' }, 403);
    }

    const body = (await request.json().catch(() => ({}))) as { pin?: unknown };
    const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
    if (pin.length < 4 || pin.length > 32) {
      return jsonResponse({ error: 'Bitte eine PIN mit 4 bis 32 Zeichen wählen.' }, 400);
    }

    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const saltHex = bytesToHex(salt);
    const hashHex = await pbkdf2Hash(pin, saltHex);

    await env.DB.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)')
      .bind('pin_hash', `${saltHex}:${hashHex}`)
      .run();

    const session = await createSession(env);
    return jsonResponse({ ...session, configured: true }, 201);
  }

  // POST /api/auth/login
  if (subPath === 'auth/login' && method === 'POST') {
    const status = await getPinStatus(env);
    if (!status.configured) {
      return jsonResponse({ error: 'Bitte zuerst eine Upload-PIN einrichten.' }, 409);
    }
    const body = (await request.json().catch(() => ({}))) as { pin?: unknown };
    const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
    if (!pin || !(await verifyPin(env, pin))) {
      return jsonResponse({ error: 'Die eingegebene Team-PIN ist nicht korrekt.' }, 401);
    }
    const session = await createSession(env);
    return jsonResponse(session);
  }

  // POST /api/auth/logout
  if (subPath === 'auth/logout' && method === 'POST') {
    const token = getBearerToken(request);
    if (token) {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    }
    return jsonResponse({ ok: true });
  }

  // GET /api/photos
  if (subPath === 'photos' && method === 'GET') {
    await purgeExpired(env, now);
    const rows = await env.DB.prepare(
      'SELECT * FROM photos WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(now, MAX_ACTIVE_PHOTOS)
      .all<PhotoRow>();

    return jsonResponse({
      serverNow: now,
      ttlMs: PHOTO_TTL_MS,
      maxPhotos: MAX_ACTIVE_PHOTOS,
      photos: rows.results.map((row) => toMeta(row, now)),
    });
  }

  // POST /api/photos (PIN session required)
  if (subPath === 'photos' && method === 'POST') {
    const authenticated = await isValidSession(env, getBearerToken(request));
    if (!authenticated) {
      return jsonResponse({ error: 'Bitte zuerst mit der Team-PIN anmelden.' }, 401);
    }

    await purgeExpired(env, now);

    const formData = await request.formData().catch(() => null);
    const uploaded = formData?.get('photo');
    if (!uploaded || typeof uploaded === 'string') {
      return jsonResponse({ error: 'Bitte eine Bilddatei auswählen.' }, 400);
    }

    const file = uploaded as File;
    if (file.size === 0 || file.size > MAX_FILE_SIZE_BYTES) {
      return jsonResponse({ error: 'Das Foto muss zwischen 1 Byte und 15 MB groß sein.' }, 413);
    }

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const detectedMime = detectImageMimeType(bytes);
    if (!detectedMime) {
      return jsonResponse({ error: 'Nur JPEG-, PNG- oder WebP-Fotos werden unterstützt.' }, 400);
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + PHOTO_TTL_MS;
    const fileName = buildSafeFileName(detectedMime, createdAt);
    const r2Key = `live/${id}`;
    const { width, height } = parseImageDimensions(bytes, detectedMime);

    // 1. Store lossless original binary in Cloudflare R2
    await env.PHOTOS_BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType: detectedMime },
    });

    // 2. Store metadata in Cloudflare D1
    await env.DB.prepare(
      `INSERT INTO photos (id, r2_key, file_name, mime_type, size_bytes, width, height, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, r2Key, fileName, detectedMime, bytes.length, width, height, createdAt, expiresAt)
      .run();

    // 3. Delete oldest photos beyond 30 from both R2 and D1
    await enforceMaxPhotoCap(env);

    return jsonResponse(
      {
        serverNow: createdAt,
        photo: {
          id,
          fileName,
          mimeType: detectedMime,
          sizeBytes: bytes.length,
          width,
          height,
          createdAt,
          expiresAt,
          remainingMs: PHOTO_TTL_MS,
        },
      },
      201,
    );
  }

  // GET /api/photos/:id/file
  const fileMatch = subPath.match(/^photos\/([a-zA-Z0-9-]+)\/file$/);
  if (fileMatch && method === 'GET') {
    const id = fileMatch[1];
    const row = await env.DB.prepare('SELECT * FROM photos WHERE id = ?')
      .bind(id)
      .first<PhotoRow>();

    if (!row) {
      return jsonResponse({ error: 'Foto wurde bereits gelöscht.' }, 404);
    }

    if (row.expires_at <= now) {
      await env.PHOTOS_BUCKET.delete(row.r2_key);
      await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
      return jsonResponse({ error: 'Dieses Foto ist abgelaufen und wurde gelöscht.' }, 404);
    }

    const object = await env.PHOTOS_BUCKET.get(row.r2_key);
    if (!object) {
      await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
      return jsonResponse({ error: 'Bilddatei nicht mehr vorhanden.' }, 404);
    }

    const forceDownload = url.searchParams.get('download') === '1';
    const disposition = forceDownload ? 'attachment' : 'inline';

    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': row.mime_type,
        'Content-Length': String(row.size_bytes),
        'Content-Disposition': `${disposition}; filename="${row.file_name}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  // DELETE /api/photos/:id (PIN session required)
  const deleteMatch = subPath.match(/^photos\/([a-zA-Z0-9-]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const authenticated = await isValidSession(env, getBearerToken(request));
    if (!authenticated) {
      return jsonResponse({ error: 'Bitte zuerst mit der Team-PIN anmelden.' }, 401);
    }

    const id = deleteMatch[1];
    const row = await env.DB.prepare('SELECT id, r2_key FROM photos WHERE id = ?')
      .bind(id)
      .first<{ id: string; r2_key: string }>();

    if (!row) {
      return jsonResponse({ error: 'Foto wurde nicht gefunden.' }, 404);
    }

    await env.PHOTOS_BUCKET.delete(row.r2_key);
    await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true, id });
  }

  return jsonResponse({ error: 'Endpunkt nicht gefunden.' }, 404);
};
