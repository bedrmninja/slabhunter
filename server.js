import express from 'express';
import compression from 'compression';
import crypto from 'node:crypto';
import { readJSON, writeJSON, csvToObjects } from './lib/util.js';
import { downloadPriceGuide, fetchProduct, isPokemon } from './lib/pricecharting.js';
import { normalizePopRow, matchPop, fetchSetFromApify } from './lib/pop.js';
import { fetchSet as fetchPptSet, searchSets as searchPptSets } from './lib/pokemonpricetracker.js';

const PORT = +process.env.PORT || 3000;
const REFRESH_MS = (+process.env.REFRESH_HOURS || 24) * 3600 * 1000;

/* ---------- state ---------- */
let prices = readJSON('prices', { updatedAt: null, products: [] });   // PriceCharting snapshot
let pop = readJSON('pop', { sets: {} });                                // { sets: { [pcSet]: {rows, importedAt, source} } }
let setMap = readJSON('sets', {});                                      // { [pcSet]: psaPopSetUrl }
let cardsCache = null;
let matchStats = { matched: 0, low: 0 };
let lastPriceError = null;
let refreshing = false;

function rebuild() {
  const m = matchPop(prices.products, pop.sets);
  let low = 0;
  const cards = [];
  for (const p of prices.products) {
    if (!p.raw || !(p.psa10 || p.bgs10 || p.cgc10)) continue;   // nothing to evaluate
    const mp = m.get(p.id);
    if (mp?.conf === 'low') low++;
    cards.push({
      id: p.id, n: p.name, s: p.set, raw: p.raw, g8: p.g8, g9: p.g9, g95: p.g95,
      psa10: p.psa10, bgs10: p.bgs10, cgc10: p.cgc10, vol: p.vol,
      ...(p.src === 'ppt' && p.tcgId ? { u: `https://www.tcgplayer.com/product/${encodeURIComponent(p.tcgId)}` } : {}),
      ...(mp ? { p10: mp.pop10, p9: mp.pop9, pt: mp.total, pc: mp.conf, pn: mp.psaName } : {}),
    });
  }
  matchStats = { matched: m.size, low };
  const body = JSON.stringify({ updatedAt: prices.updatedAt, popSets: Object.keys(pop.sets).length, cards });
  cardsCache = { body, etag: '"' + crypto.createHash('sha1').update(body).digest('base64url') + '"' };
}

async function refreshPrices() {
  if (refreshing) throw new Error('A price refresh is already running.');
  refreshing = true;
  try {
    const products = await downloadPriceGuide();
    if (!products.length) throw new Error('The CSV had no Pokémon products. Check the download link.');
    // Keep sets loaded from PokemonPriceTracker; the CSV only replaces PriceCharting cards.
    prices = { updatedAt: new Date().toISOString(), products: [...products, ...prices.products.filter(p => p.src === 'ppt')] };
    writeJSON('prices', prices);
    lastPriceError = null;
    rebuild();
    return products.length;
  } catch (e) {
    lastPriceError = { at: new Date().toISOString(), message: e.message };
    throw e;
  } finally { refreshing = false; }
}

function stale() {
  return !prices.updatedAt || Date.now() - Date.parse(prices.updatedAt) > REFRESH_MS;
}
async function scheduledRefresh() {
  if (!stale() || !(process.env.PRICECHARTING_CSV_URL || process.env.PRICECHARTING_CSV_FILE)) return;
  try { console.log(`Refreshed prices: ${await refreshPrices()} products`); }
  catch (e) { console.error('Scheduled price refresh failed:', e.message); }
}

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '25mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '25mb' }));

function admin(req, res, next) {
  const want = process.env.ADMIN_TOKEN;
  if (!want) return res.status(503).json({ error: 'Set ADMIN_TOKEN in .env to use admin actions.' });
  const got = String(req.get('x-admin-token') || '');
  const ok = got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return res.status(401).json({ error: 'Admin token is wrong.' });
  next();
}
const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.message }));

// Public
app.get('/api/cards', (req, res) => {
  if (!cardsCache) rebuild();
  res.set('ETag', cardsCache.etag).set('Cache-Control', 'no-cache');
  if (req.get('if-none-match') === cardsCache.etag) return res.status(304).end();
  res.type('json').send(cardsCache.body);
});

app.get('/api/status', (req, res) => {
  res.json({
    pricesUpdatedAt: prices.updatedAt,
    productCount: prices.products.length,
    lastPriceError,
    refreshing,
    csvConfigured: !!(process.env.PRICECHARTING_CSV_URL || process.env.PRICECHARTING_CSV_FILE),
    apiConfigured: !!process.env.PRICECHARTING_TOKEN,
    pptConfigured: !!process.env.PPT_API_KEY,
    pptSets: [...new Set(prices.products.filter(p => p.src === 'ppt').map(p => p.set))],
    apifyConfigured: !!process.env.APIFY_TOKEN,
    pop: Object.fromEntries(Object.entries(pop.sets).map(([k, v]) => [k, { rows: v.rows.length, importedAt: v.importedAt, source: v.source }])),
    matched: matchStats.matched,
    lowConfidence: matchStats.low,
  });
});

// Admin
app.post('/api/admin/refresh-prices', admin, wrap(async (req, res) => {
  res.json({ products: await refreshPrices() });
}));

app.post('/api/admin/refresh-card/:id', admin, wrap(async (req, res) => {
  const fresh = await fetchProduct(req.params.id);
  const i = prices.products.findIndex(p => p.id === fresh.id);
  // API responses may omit set/genre; keep what the CSV gave us.
  if (i >= 0) prices.products[i] = { ...prices.products[i], ...Object.fromEntries(Object.entries(fresh).filter(([, v]) => v != null && v !== '')) };
  else if (isPokemon(fresh)) prices.products.push(fresh);
  writeJSON('prices', prices);
  rebuild();
  res.json(fresh);
}));

// PokemonPriceTracker: load (or reload) one set. Replaces that set's PokemonPriceTracker cards.
app.post('/api/admin/ppt/load', admin, wrap(async (req, res) => {
  const set = String(req.body?.set || '').trim();
  if (!set) throw new Error('Enter a set name or set id (e.g. "Evolving Skies"). Use "Find sets" to look one up.');
  const limit = Math.max(0, Math.floor(+req.body?.limit || 0));
  const { products, received, usage, sample } = await fetchPptSet({ set, limit, graded: req.body?.graded !== false });
  const withTen = products.filter(p => p.psa10 || p.bgs10 || p.cgc10).length;
  if (products.length) {
    prices = {
      updatedAt: new Date().toISOString(),
      products: [...prices.products.filter(p => !(p.src === 'ppt' && p.set === set)), ...products],
    };
    writeJSON('prices', prices);
    rebuild();
  }
  res.json({
    set, received, loaded: products.length, withGradedPrice: withTen, withRawPrice: products.filter(p => p.raw).length,
    creditsInfo: usage, sampleKeys: sample ? Object.keys(sample) : [],
    // Only shown when graded prices didn't come through, so you can see what fields the API used.
    ...(products.length && !withTen ? { sample } : {}),
  });
}));

app.get('/api/admin/ppt/sets', admin, wrap(async (req, res) => {
  res.json(await searchPptSets(String(req.query.search || '').trim()));
}));

// Drop prices that didn't come from PokemonPriceTracker (e.g. the sample CSV), or everything.
app.post('/api/admin/clear-prices', admin, (req, res) => {
  const before = prices.products.length;
  prices = { ...prices, products: req.body?.all ? [] : prices.products.filter(p => p.src === 'ppt') };
  writeJSON('prices', prices);
  rebuild();
  res.json({ removed: before - prices.products.length, left: prices.products.length });
});

app.get('/api/admin/sets', admin, (req, res) => {
  const pcSets = [...new Set(prices.products.map(p => p.set))].sort();
  res.json({ map: setMap, pcSets });
});

app.put('/api/admin/sets', admin, wrap(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new Error('Send an object of { "PriceCharting set name": "PSA pop set URL" }.');
  setMap = Object.fromEntries(Object.entries(req.body).filter(([k, v]) => k && typeof v === 'string' && v.trim()).map(([k, v]) => [k.trim(), v.trim()]));
  writeJSON('sets', setMap);
  res.json({ map: setMap });
}));

// Import pop rows for one PriceCharting set: body is CSV text (?set=...) or JSON {set, rows:[...]}
app.post('/api/admin/pop/import', admin, wrap(async (req, res) => {
  const set = String(req.query.set || req.body?.set || '').trim();
  if (!set) throw new Error('Say which PriceCharting set these rows belong to (e.g. "Pokemon Evolving Skies").');
  const rawRows = typeof req.body === 'string' ? csvToObjects(req.body) : (req.body?.rows || []);
  const rows = rawRows.map(normalizePopRow).filter(Boolean);
  if (!rows.length) throw new Error(`None of the ${rawRows.length} rows had a card number and a PSA 10 count. Expected columns like: number, name, variety, pop10, pop9, total.`);
  pop.sets[set] = { rows, importedAt: new Date().toISOString(), source: 'import' };
  writeJSON('pop', pop);
  rebuild();
  res.json({ set, received: rawRows.length, parsed: rows.length, matched: matchStats.matched });
}));

// Pull pop for mapped sets from Apify, one set at a time.
app.post('/api/admin/pop/apify', admin, wrap(async (req, res) => {
  const only = req.body?.set ? [req.body.set] : Object.keys(setMap);
  if (!only.length) throw new Error('Map at least one PriceCharting set to a PSA pop set URL first.');
  const results = [];
  for (const set of only) {
    const url = setMap[set];
    if (!url) { results.push({ set, error: 'No PSA URL mapped.' }); continue; }
    try {
      const { rows, received, sample } = await fetchSetFromApify(url);
      if (rows.length) pop.sets[set] = { rows, importedAt: new Date().toISOString(), source: 'apify' };
      results.push({ set, received, parsed: rows.length, sampleKeys: sample ? Object.keys(sample) : [] });
    } catch (e) { results.push({ set, error: e.message }); }
  }
  writeJSON('pop', pop);
  rebuild();
  res.json({ results, matched: matchStats.matched });
}));

app.delete('/api/admin/pop/:set', admin, (req, res) => {
  delete pop.sets[req.params.set];
  writeJSON('pop', pop);
  rebuild();
  res.json({ ok: true });
});

// Cards in a set that didn't match (to spot naming problems)
app.get('/api/admin/unmatched', admin, (req, res) => {
  const set = String(req.query.set || '');
  const m = matchPop(prices.products, pop.sets);
  const list = prices.products.filter(p => p.set === set && (!m.has(p.id) || m.get(p.id).conf === 'low'))
    .slice(0, 200).map(p => ({ id: p.id, name: p.name, conf: m.get(p.id)?.conf ?? 'none', psaName: m.get(p.id)?.psaName ?? null }));
  res.json({ set, list });
});

app.use(express.static('public', { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Slab Hunter on http://localhost:${PORT}`);
  rebuild();
  scheduledRefresh();
  setInterval(scheduledRefresh, 60 * 60 * 1000).unref();
});
