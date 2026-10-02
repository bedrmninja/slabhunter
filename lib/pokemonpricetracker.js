// PokemonPriceTracker client (pokemonpricetracker.com/api-reference).
//  - Auth: "Authorization: Bearer <key>".
//  - GET /api/v2/cards with setName/setId + fetchAllInSet returns every card in a set.
//    includeEbay adds graded sales (ebay.salesByGrade.psa10.medianPrice etc.).
//  - Credits: about 1 per card, plus 2 more per card with includeEbay. Free accounts get 100 a day,
//    so a free account can load roughly 30 cards a day with graded prices.
//  - Field names below were taken from their docs, not checked against a real response.
//    Loading a set returns `sampleKeys` and `sample`; if graded prices come back empty, add the
//    real names to the alias lists in A.
import { pick, toNumber, sleep } from './util.js';

const BASE = process.env.PPT_BASE_URL || 'https://www.pokemonpricetracker.com/api/v2';   // override only for tests
const MIN_INTERVAL_MS = 1100;
let lastAt = 0;

const A = {
  id:     ['tcgPlayerId', 'tcgplayerId', 'tcgplayer_id', 'productId', 'id', '_id'],
  name:   ['name', 'cardName', 'productName', 'title'],
  number: ['cardNumber', 'number', 'card_number', 'collectorNumber'],
  set:    ['setName', 'set', 'set_name', 'expansion'],
  market: ['market', 'marketPrice', 'market_price', 'mid', 'midPrice', 'price'],
  median: ['medianPrice', 'median', 'median_price', 'avgPrice', 'averagePrice', 'average', 'avg', 'price'],
  count:  ['count', 'salesCount', 'sales', 'totalSales', 'numSales', 'sampleSize'],
  grades: ['salesByGrade', 'grades', 'gradedPrices', 'graded'],
};
// Our field -> grade keys PokemonPriceTracker may use.
const GRADES = {
  psa10: ['psa10', 'psa_10', 'PSA 10'],
  g95:   ['psa9.5', 'psa95', 'psa9_5', 'bgs9.5', 'bgs95', 'bgs9_5', 'cgc9.5', 'cgc95'],
  g9:    ['psa9', 'psa_9', 'PSA 9'],
  g8:    ['psa8', 'psa_8', 'PSA 8'],
  g7:    ['psa7', 'psa_7', 'PSA 7'],
  bgs10: ['bgs10', 'bgs_10', 'BGS 10'],
  cgc10: ['cgc10', 'cgc_10', 'CGC 10'],
  sgc10: ['sgc10', 'sgc_10', 'SGC 10'],
};

function key() {
  const k = process.env.PPT_API_KEY;
  if (!k) throw new Error('PPT_API_KEY is not set. Add your PokemonPriceTracker API key to .env and restart.');
  return k;
}

async function get(path, params) {
  const wait = lastAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { Authorization: `Bearer ${key()}`, Accept: 'application/json' } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || json?.message || text.slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new Error(`PokemonPriceTracker rejected the API key (HTTP ${res.status}): ${msg}`);
    if (res.status === 429) throw new Error(`Out of PokemonPriceTracker credits or rate limited (HTTP 429): ${msg}`);
    throw new Error(`PokemonPriceTracker error (HTTP ${res.status}): ${msg}`);
  }
  if (!json) throw new Error('PokemonPriceTracker returned something that is not JSON.');
  // Any credit / rate-limit headers, so the admin page can show what's left.
  const usage = {};
  res.headers.forEach((v, k) => { if (/credit|ratelimit|rate-limit|remaining/i.test(k)) usage[k] = v; });
  return { json, usage };
}

const list = json => (Array.isArray(json) ? json : json.data ?? json.cards ?? json.results ?? json.sets ?? []);

/** Price from a value that may be a number or an object like {medianPrice, count}. */
function gradePrice(v) {
  if (v == null) return { price: null, count: null };
  if (typeof v !== 'object') return { price: toNumber(v), count: null };
  return { price: toNumber(pick(v, A.median)), count: toNumber(pick(v, A.count)) };
}

/** One PokemonPriceTracker card -> the same product record shape PriceCharting cards use. */
export function normalizeCard(c, fallbackSet) {
  const id = pick(c, A.id);
  let name = String(pick(c, A.name) ?? '').trim();
  if (id == null || !name) return null;
  const number = pick(c, A.number);
  // Pop matching reads the card number from "#123" in the name.
  if (number != null && !/#\s*\S/.test(name)) name = `${name} #${String(number).split('/')[0].trim()}`;

  const prices = c.prices && typeof c.prices === 'object' ? c.prices : {};
  const raw = toNumber(pick(prices, A.market)) ?? toNumber(pick(c, A.market));

  const ebay = c.ebay && typeof c.ebay === 'object' ? c.ebay : {};
  const byGrade = pick(ebay, A.grades) ?? pick(c, A.grades) ?? {};
  const out = { id: `ppt-${id}`, name, set: fallbackSet || String(pick(c, A.set) ?? '').trim(), genre: 'Pokemon Card', raw, src: 'ppt', tcgId: String(id) };
  let sales = 0, anySales = false;
  for (const [field, aliases] of Object.entries(GRADES)) {
    const { price, count } = gradePrice(pick(byGrade, aliases));
    out[field] = price && price > 0 ? price : null;
    if (count != null) { sales += count; anySales = true; }
  }
  out.vol = anySales ? sales : null;   // graded eBay sales in their window, not PriceCharting's yearly volume
  return out;
}

/** Every card in one set. `limit` caps how many cards (and credits) a load uses. */
export async function fetchSet({ set, limit, graded = true }) {
  const looksLikeId = /^[a-z0-9-]+$/i.test(set) && /\d/.test(set) && !/\s/.test(set);
  const { json, usage } = await get('/cards', {
    [looksLikeId ? 'setId' : 'setName']: set,
    fetchAllInSet: limit ? undefined : 'true',
    limit: limit || undefined,
    includeEbay: graded ? 'true' : undefined,
  });
  const items = list(json);
  if (!Array.isArray(items)) throw new Error('PokemonPriceTracker response had no list of cards.');
  const products = items.map(c => normalizeCard(c, set)).filter(Boolean);
  return { products, received: items.length, usage, sample: items[0] ?? null };
}

/** Look up set names/ids, so you know what to type into "Load set". */
export async function searchSets(search) {
  const { json, usage } = await get('/sets', { search, limit: 50 });
  const sets = list(json).map(s => ({
    name: pick(s, ['name', 'setName']), id: pick(s, ['tcgPlayerId', 'id', 'setId', '_id']),
    series: pick(s, ['series', 'seriesName']) ?? null, released: pick(s, ['releaseDate', 'released']) ?? null,
  }));
  return { sets, usage };
}
