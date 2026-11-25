#!/usr/bin/env node
/**
 * Fotobox Ordner-Watcher für Mac & Windows (ohne externe Abhängigkeiten)
 * Überwacht einen lokalen Kamera-Ordner, lädt neue Fotos (JPEG/PNG/WebP)
 * in voller Originalqualität hoch und löscht sie nach erfolgreichem Upload.
 *
 * Start (Node.js 18+ erforderlich):
 *   node scripts/fotobox-watcher.mjs "./kamera-ordner" "https://deine-seite.pages.dev" "DEINE_TEAM_PIN"
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const [, , watchDirArg, baseUrlArg, pinArg] = process.argv;

if (!watchDirArg || !baseUrlArg || !pinArg) {
  console.error(
    'Nutzung: node scripts/fotobox-watcher.mjs <ORDNER_PFAD> <WEBSEITEN_URL> <TEAM_PIN>',
  );
  process.exit(1);
}

const WATCH_DIR = path.resolve(watchDirArg);
const BASE_URL = baseUrlArg.replace(/\/+$/, '');
const PIN = pinArg.trim();
const IMAGE_REGEX = /\.(jpe?g|png|webp)$/i;
const MAX_BYTES = 15 * 1024 * 1024;

let token = null;
const stabilityMap = new Map();
const inFlight = new Set();

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
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
      console.warn(`Übersprungen (${fileName}): ungültige Größe (${buffer.length} Bytes)`);
      return;
    }

    const form = new FormData();
    form.append('photo', new Blob([buffer], { type: guessMime(fileName) }), fileName);

    let res = await fetch(`${BASE_URL}/api/photos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    if (res.status === 401) {
      await login();
      res = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    await fs.unlink(fullPath);
    stabilityMap.delete(fileName);
    console.log(
      `[${new Date().toLocaleTimeString('de-DE')}] Hochgeladen & lokal gelöscht: ${fileName}`,
    );
  } catch (err) {
    console.error(`Fehler bei ${fileName} (Datei bleibt erhalten):`, err.message);
  } finally {
    inFlight.delete(fileName);
  }
}

async function scan() {
  const entries = await fs.readdir(WATCH_DIR, { withFileTypes: true });
  const activeNames = new Set();

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !IMAGE_REGEX.test(entry.name)) {
      continue;
    }
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
    if (!activeNames.has(known)) {
      stabilityMap.delete(known);
    }
  }
}

await login();
console.log(`Überwache Ordner: ${WATCH_DIR} (Strg+C zum Beenden)`);
setInterval(() => {
  scan().catch((err) => console.error('Scan-Fehler:', err.message));
}, 1500);
