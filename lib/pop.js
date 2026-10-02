// PSA population data: normalize rows from any source, then match them to PriceCharting products.
//
// Matching works per set. You map each PriceCharting set name (console-name, e.g. "Pokemon Evolving Skies")
// to a PSA pop set, import that set's pop rows, and cards are matched by card number, then by name/variety words.
import { pick, toNumber } from './util.js';

const A = {
  number: ['cardNumber', 'card_number', 'card number', 'CardNumber', 'number', 'no', 'card #', 'card no'],
  name:   ['name', 'subject', 'SubjectName', 'Subject', 'cardName', 'card_name', 'player', 'description', 'title'],
  variety:['variety', 'Variety', 'variation', 'parallel', 'VarietyPedigree'],
  pop10:  ['pop10', 'psa10', 'grade10', 'Grade10', 'gem', 'gemMint10', 'g10', '10'],
  pop9:   ['pop9', 'psa9', 'grade9', 'Grade9', 'g9', '9'],
  total:  ['total', 'Total', 'totalPopulation', 'total_population', 'totalGraded', 'population', 'pop', 'GradeTotal'],
  specId: ['specId', 'SpecID', 'spec_id', 'specID'],
};

/** Try hard to read counts that may be nested (e.g. {grades:{"10":123}} or {population:{psa10:..}}). */
function deepCount(row, aliases) {
  const direct = toNumber(pick(row, aliases));
  if (direct != null) return direct;
  for (const v of Object.values(row)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const n = toNumber(pick(v, aliases));
      if (n != null) return n;
    }
  }
  return null;
}

export function normNumber(n) {
  if (n == null) return null;
  let s = String(n).trim().toLowerCase();
  s = s.replace(/^#/, '').split('/')[0].trim();          // "215/203" -> "215"
  s = s.replace(/^0+(?=[0-9])/, '');                     // "007" -> "7"
  return s || null;
}

export function numberFromName(name) {
  const m = String(name).match(/#\s*([a-z]*\d+[a-z0-9-]*)/i);
  return m ? normNumber(m[1]) : null;
}

const STOP = new Set(['the', 'of', 'and', 'a', 'pokemon', 'card', 'cards', 'en', 'eng', 'english']);
export function tokens(s) {
  return new Set(String(s || '').toLowerCase()
    .replace(/#\s*[a-z0-9/-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t && !STOP.has(t) && !/^\d+$/.test(t)));
}
// Words that separate otherwise-identical cards. A mismatch on these is a strong negative.
const VARIANT = ['reverse', '1st', 'shadowless', 'unlimited', 'promo', 'stamped', 'staff', 'prerelease', 'jumbo', 'error', 'cosmos', 'masterball', 'pokeball'];

/** Normalize one pop row from CSV/JSON/Apify. Returns null if it has no usable counts. */
export function normalizePopRow(row) {
  const name = String(pick(row, A.name) ?? '').trim();
  const variety = String(pick(row, A.variety) ?? '').trim();
  const number = normNumber(pick(row, A.number)) ?? numberFromName(name);
  const pop10 = deepCount(row, A.pop10);
  const pop9 = deepCount(row, A.pop9);
  let total = deepCount(row, A.total);
  if (pop10 == null || !number) return null;
  if (total == null || total < pop10) total = null;
  return { number, name, variety, pop10, pop9, total, specId: pick(row, A.specId) ?? null };
}

function score(product, popRow) {
  const a = tokens(product.name);
  const b = tokens(`${popRow.name} ${popRow.variety}`);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size || 1;
  let s = inter / union;
  for (const v of VARIANT) if (a.has(v) !== b.has(v)) s -= 0.35;
  return s;
}

/**
 * Match products to pop rows.
 * popSets: { [pcSetName]: { rows: [normalized pop rows] } }
 * returns: Map productId -> { pop10, pop9, total, conf: 'high'|'medium'|'low', psaName }
 */
export function matchPop(products, popSets) {
  const index = new Map(); // set -> number -> rows[]
  for (const [set, data] of Object.entries(popSets || {})) {
    const byNum = new Map();
    for (const r of data.rows || []) {
      if (!byNum.has(r.number)) byNum.set(r.number, []);
      byNum.get(r.number).push(r);
    }
    index.set(set.toLowerCase(), byNum);
  }
  const out = new Map();
  for (const p of products) {
    const byNum = index.get(p.set.toLowerCase());
    if (!byNum) continue;
    const num = numberFromName(p.name);
    if (!num) continue;
    const cands = byNum.get(num);
    if (!cands || !cands.length) continue;
    const ranked = cands.map(r => ({ r, s: score(p, r) })).sort((x, y) => y.s - x.s);
    const best = ranked[0], second = ranked[1];
    let conf;
    if (ranked.length === 1) conf = best.s > 0 ? 'high' : 'medium';
    else if (best.s > 0.2 && best.s - second.s >= 0.15) conf = 'medium';
    else conf = 'low';
    if (best.s < -0.2) conf = 'low';
    const r = best.r;
    out.set(p.id, { pop10: r.pop10, pop9: r.pop9, total: r.total, conf, psaName: [r.name, r.variety].filter(Boolean).join(' · ') });
  }
  return out;
}

/**
 * Pull one PSA pop set page through an Apify actor. The actor's output format isn't standardized,
 * so rows go through normalizePopRow's tolerant field detection. Check the admin page's
 * "rows parsed" count after the first run to confirm it read the actor's fields.
 */
export async function fetchSetFromApify(psaSetUrl) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not set.');
  const actor = process.env.APIFY_ACTOR || 'lulzasaur~psa-pop-scraper';
  const key = process.env.APIFY_INPUT_KEY || 'setUrl';
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: psaSetUrl }),
  });
  if (!res.ok) throw new Error(`Apify run failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error('Apify returned something other than a list of rows.');
  const rows = items.map(normalizePopRow).filter(Boolean);
  return { rows, received: items.length, sample: items[0] ?? null };
}
