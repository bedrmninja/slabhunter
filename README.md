# Slab Hunter

Ranks raw Pokémon cards by expected profit from grading. Prices come from PriceCharting (your API subscription), and grade odds come from PSA population reports.

```
public/index.html   the ranking app (all maths runs in the browser)
public/admin.html   refresh prices, map sets, import pop data
server.js           holds your keys, caches data, serves both pages
lib/pricecharting.js  CSV download + throttled /api/product calls
lib/pokemonpricetracker.js  per-set price loading from PokemonPriceTracker
lib/pop.js          pop row parsing + matching pop rows to PriceCharting cards
```

## Run it

Needs Node 22.9 or newer.

```bash
npm install
cp .env.example .env      # then fill it in (see below)
npm start                 # http://localhost:3000, admin at /admin
```

To try it without a subscription, set `PRICECHARTING_CSV_FILE=./sample/prices.csv` and `ADMIN_TOKEN=anything`. Then import `sample/pop-evolving-skies.csv` for the set "Pokemon Evolving Skies" on the admin page. The sample prices are made up.

## Prices from PokemonPriceTracker (instead of PriceCharting)

If you don't have PriceCharting's Legendary plan, prices can come from pokemonpricetracker.com.

1. Put your API key in `.env` as `PPT_API_KEY=...` and restart.
2. On the admin page, use **Find sets** to get the exact set name, then **Load set**.
3. Click **Remove sample / PriceCharting prices** once, so the made-up sample cards go away.

Each card costs about 3 credits with graded prices (1 for the card, 2 for eBay graded sales). The free account's 100 credits a day covers about 30 cards, so **Max cards** defaults to 10. Leave it blank to load a whole set on a paid plan. Loading a set again replaces that set's prices.

The connector's field names come from PokemonPriceTracker's docs and weren't checked against a real response. If a load says `withGradedPrice: 0`, the output includes one raw card from their API: add its field names to the alias lists at the top of `lib/pokemonpricetracker.js`.

## Fill in .env

**PRICECHARTING_TOKEN and PRICECHARTING_CSV_URL.** Both come from pricecharting.com/subscriptions, under the "API/Download" button. The bulk CSV download needs the Legendary plan. The app follows PriceCharting's limits: the CSV at most once every 10 minutes (the file itself only changes daily), and the API at most one call per second. Prices refresh by themselves every `REFRESH_HOURS`.

**ADMIN_TOKEN.** Any long random string, for example from `openssl rand -hex 24`. The admin page asks for it.

**APIFY_TOKEN** (optional). For pulling PSA pop data automatically; see below.

## PSA pop data

PriceCharting's API doesn't include population data. PSA's public API mainly covers cert lookups. So pop data comes in one of two ways:

1. **CSV import** (free). On the admin page, pick the PriceCharting set and upload a CSV with columns like `number, name, variety, pop10, pop9, total`. Column names are matched loosely.
2. **Apify actor** (paid per run). Map each PriceCharting set name to its PSA pop page URL on the admin page, then click "Pull pop from Apify". The default actor is `lulzasaur~psa-pop-scraper`, which takes a `setUrl` input.
   - **Unverified:** its output field names weren't checked against a real run. The parser guesses common field names, including nested ones.
   - **After your first run:** check the admin page's `received` vs `parsed` counts, and `sampleKeys`. If `parsed` is 0, add the actor's field names to the alias lists at the top of `lib/pop.js`.

Cards are matched within a set by card number, then by name and variant words such as reverse, 1st edition or shadowless. Uncertain matches are shown with a dashed tag and aren't used. Use "Show unmatched" on the admin page to find naming problems.

Pop gem rates are blended with your default rate. This keeps a card with 12 graded copies from swinging the rankings. They also run optimistic, because submitters pre-screen their best copies. That's why the blend setting is exposed in the UI.

## Before you open this to other people

**PriceCharting licence.** PriceCharting's API terms say their data is for internal use only. Showing it inside an app or service used by others needs a commercial licence and their written permission. Run this for yourself as-is, and contact PriceCharting before sharing it publicly. Their terms also say to purge stored data when your subscription ends. To do that, delete `data/prices.json`.

**PSA pop data.** Scraping PSA's site is governed by PSA's terms. Read them, or get pop data through a licensed route (PSA offers paid API access), before publishing anything built on it.

## Deploying

This is a plain Node app with no database. Data lives as JSON files in `DATA_DIR`.

- It runs on any host that keeps a persistent disk: Railway, Render or Fly.io with a volume, or a small VPS.
- Put `.env` values in the host's secret settings.
- Keep `/admin` private. It's token-protected, but you can also block it at your proxy.
