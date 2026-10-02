// PriceCharting client.
// Docs: https://www.pricecharting.com/api-documentation
//  - API prices are integer pennies; CSV prices are dollars with two decimals.
//  - API: max 1 call per second. CSV: max 1 download per 10 minutes, regenerated every 24h.
//  - Card field mapping: loose=Ungraded, cib=Grade 7, new=Grade 8, graded=Grade 9,
//    box-only=Grade 9.5, manual-only=PSA 10, bgs-10=BGS 10, condition-17=CGC 10, condition-18=SGC 10.
import fs from 'node:fs';
import { csvToObjects, toNumber, sleep } from './util.js';

const BASE = 'https://www.pricecharting.com';
const CSV_MIN_INTERVAL_MS = 10 * 60 * 1000;
const API_MIN_INTERVAL_MS = 1100;

let lastCsvAt = 0;
let lastApiAt = 0;
let apiChain = Promise.resolve();

function token() {
  const t = process.env.PRICECHARTING_TOKEN;
  if (!t) throw new Error('PRICECHARTING_TOKEN is not set.');
  return t;
}

/** Serialize API calls so we never exceed 1/sec, however many requests arrive. */
function throttled(fn) {
  const run = apiChain.then(async () => {
    const wait = lastApiAt + API_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastApiAt = Date.now();
    return fn();
  });
  apiChain = run.catch(() => {});
  return run;
}

function price(v, pennies) {
  const n = toNumber(v);
  if (n == null || n <= 0) return null;
  return pennies ? n / 100 : n;
}

export function isPokemon(p) {
  return /pok[eé]mon/i.test(`${p.set} ${p.genre}`);
}

/** One CSV row or API object -> compact product record (prices in dollars). */
export function normalizeProduct(o, pennies) {
  const id = String(o['id'] ?? '').trim();
  const name = String(o['product-name'] ?? '').trim();
  if (!id || !name) return null;
  const p = k => price(o[k], pennies);
  return {
    id,
    name,
    set: String(o['console-name'] ?? '').trim(),
    genre: String(o['genre'] ?? '').trim(),
    raw: p('loose-price'),
    g7: p('cib-price'),
    g8: p('new-price'),
    g9: p('graded-price'),
    g95: p('box-only-price'),
    psa10: p('manual-only-price'),
    bgs10: p('bgs-10-price'),
    cgc10: p('condition-17-price'),
    sgc10: p('condition-18-price'),
    vol: toNumber(o['sales-volume']),
    tcgId: o['tcg-id'] ? String(o['tcg-id']) : null,
  };
}

/** Download the full price guide CSV. Returns normalized products. */
export async function downloadPriceGuide() {
  let text;
  if (process.env.PRICECHARTING_CSV_FILE) {
    text = fs.readFileSync(process.env.PRICECHARTING_CSV_FILE, 'utf8');
  } else {
    const url = process.env.PRICECHARTING_CSV_URL;
    if (!url) throw new Error('PRICECHARTING_CSV_URL is not set. Copy the CSV link from your PriceCharting subscription page.');
    const since = Date.now() - lastCsvAt;
    if (since < CSV_MIN_INTERVAL_MS) {
      throw new Error(`PriceCharting allows one CSV download every 10 minutes. Try again in ${Math.ceil((CSV_MIN_INTERVAL_MS - since) / 60000)} min.`);
    }
    lastCsvAt = Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CSV download failed: HTTP ${res.status}`);
    text = await res.text();
    if (/^\s*</.test(text)) throw new Error('CSV link returned a web page, not a CSV. Check the link and that your subscription includes downloads.');
  }
  const all = csvToObjects(text).map(r => normalizeProduct(r, false)).filter(Boolean);
  const onlyPokemon = process.env.POKEMON_ONLY !== 'false';
  return onlyPokemon ? all.filter(isPokemon) : all;
}

/** Refresh one product through the API (throttled). */
export function fetchProduct(id) {
  return throttled(async () => {
    const url = `${BASE}/api/product?t=${encodeURIComponent(token())}&id=${encodeURIComponent(id)}`;
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (json.status !== 'success') throw new Error(json['error-message'] || `PriceCharting API error: HTTP ${res.status}`);
    return normalizeProduct(json, true);
  });
}

/** Search products through the API (throttled). Returns up to 20 {id,name,set}. */
export function searchProducts(q) {
  return throttled(async () => {
    const url = `${BASE}/api/products?t=${encodeURIComponent(token())}&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (json.status !== 'success') throw new Error(json['error-message'] || `PriceCharting API error: HTTP ${res.status}`);
    return (json.products || []).map(p => normalizeProduct(p, true)).filter(Boolean);
  });
}
