// Small BOM/CRLF-tolerant file helpers shared by the loop modules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Read a text file; '' when missing or unreadable. A leading UTF-8 BOM is dropped. */
export function readText(file) {
  try {
    return stripBom(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

export function readJson(file, fallback = null) {
  const text = readText(file).trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function splitLines(text) {
  return String(text).split(/\r?\n/);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write without a BOM, creating parent directories. */
export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Append one line, retrying while another process holds the file (Windows sharing
 * violations). Returns false only when every attempt failed; telemetry must never
 * take the loop down.
 */
export function appendLine(file, line, attempts = 5) {
  ensureDir(path.dirname(file));
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.appendFileSync(file, `${line}\n`, 'utf8');
      return true;
    } catch {
      sleepSync(50 * (i + 1));
    }
  }
  return false;
}

export function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

/** Forward-slash a path for display and for storing in state files. */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

export function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-');
}
