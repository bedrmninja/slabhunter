import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { csvToObjects } from '../lib/util.js';
import { normalizePopRow, matchPop, numberFromName, normNumber } from '../lib/pop.js';
import { normalizeProduct, isPokemon } from '../lib/pricecharting.js';

test('card numbers', () => {
  assert.equal(numberFromName('Umbreon VMAX #215'), '215');
  assert.equal(numberFromName('Pikachu #SWSH039'), 'swsh039');
  assert.equal(normNumber('094'), '94');
  assert.equal(normNumber('215/203'), '215');
});

test('API prices are pennies, CSV prices are dollars', () => {
  assert.equal(normalizeProduct({ id: '1', 'product-name': 'X', 'loose-price': 1732 }, true).raw, 17.32);
  assert.equal(normalizeProduct({ id: '1', 'product-name': 'X', 'loose-price': '$17.32' }, false).raw, 17.32);
});

test('Apify-style nested rows normalize', () => {
  const r = normalizePopRow({ CardNumber: '215', SubjectName: 'Umbreon VMAX', grades: { Grade10: 50, Grade9: 20 }, Total: 100 });
  assert.deepEqual([r.number, r.pop10, r.pop9, r.total], ['215', 50, 20, 100]);
});

test('matching picks the right variant', () => {
  const products = csvToObjects(fs.readFileSync('sample/prices.csv', 'utf8')).map(o => normalizeProduct(o, false)).filter(isPokemon);
  const rows = csvToObjects(fs.readFileSync('sample/pop-evolving-skies.csv', 'utf8')).map(normalizePopRow).filter(Boolean);
  const m = matchPop(products, { 'Pokemon Evolving Skies': { rows } });
  assert.equal(m.get('1001').pop10, 9200);
  assert.equal(m.get('1004').pop10, 40, 'reverse holo goes to reverse holo row');
  assert.equal(m.get('1005').pop10, 120, 'regular goes to regular row');
  assert.ok(!m.has('1006'), 'booster box has no number, no match');
});

test('PokemonPriceTracker cards normalize', async () => {
  const { normalizeCard } = await import('../lib/pokemonpricetracker.js');
  const p = normalizeCard({
    tcgPlayerId: 246723, name: 'Umbreon VMAX', cardNumber: '215/203', setName: 'Evolving Skies',
    prices: { market: 1350.5 },
    ebay: { salesByGrade: { psa10: { medianPrice: 3300, count: 40 }, psa9: { medianPrice: 1700, count: 25 } } },
  }, 'Evolving Skies');
  assert.equal(p.id, 'ppt-246723');
  assert.equal(p.name, 'Umbreon VMAX #215');
  assert.equal(p.raw, 1350.5);
  assert.equal(p.psa10, 3300);
  assert.equal(p.g9, 1700);
  assert.equal(p.vol, 65);
  assert.equal(numberFromName(p.name), '215');
});
