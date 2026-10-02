import fs from 'node:fs';
import path from 'node:path';

/* ---------- CSV ---------- */
export function parseCSV(text) {
  const out = [];
  let row = [], f = '', inQ = false;
  text = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inQ = false; }
      else f += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); out.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); out.push(row); }
  return out.filter(r => r.some(x => x.trim() !== ''));
}

/** CSV text -> array of objects keyed by lowercased, trimmed header. */
export function csvToObjects(text) {
  const table = parseCSV(text);
  if (table.length < 2) return [];
  const head = table[0].map(h => h.trim().toLowerCase());
  return table.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** Case- and punctuation-insensitive field lookup across a list of aliases. */
export function pick(obj, aliases) {
  if (!obj) return undefined;
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const keys = Object.keys(obj);
  for (const a of aliases) {
    const na = norm(a);
    const k = keys.find(k => norm(k) === na);
    if (k !== undefined && obj[k] !== '' && obj[k] != null) return obj[k];
  }
  return undefined;
}

export function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : null;
}

/* ---------- JSON file store ---------- */
const DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DIR, { recursive: true });

export function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); }
  catch { return fallback; }
}
export function writeJSON(name, value) {
  const p = path.join(DIR, name + '.json');
  fs.writeFileSync(p + '.tmp', JSON.stringify(value));
  fs.renameSync(p + '.tmp', p);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
