// scripts/generateTrendingSocial.js
//
// Publishes which tickers are trending on Reddit and StockTwits, to the
// same public Gist as the other files in this repo, as trendingSocialCache.json.
//
// Scope note (verified live before building anything): X/Twitter has no
// free API tier at all as of 2026 (pay-per-use only, no free read
// allowance for new developers) and Facebook/Instagram has no general
// public-content search for third parties (the only related feature,
// hashtag search, is locked to your own approved business account and
// capped at 30 hashtags/week) — both are hard dead ends for a "what's
// trending" feature, not a gap this pipeline works around. Bluesky's basic
// reads work without auth but its search endpoint (the part actually
// needed here) 403s without a real account session, and its finance-
// discussion community is much smaller than Reddit's anyway — deferred,
// not built here.
//
// Both sources actually used ARE free, public, and require no API key or
// account at all (confirmed live):
//   - ApeWisdom (apewisdom.io) scans Reddit (r/wallstreetbets, r/stocks,
//     r/investing, etc.) and ranks tickers by mention count.
//   - StockTwits' own public trending-symbols endpoint, a stock-specific
//     social platform, includes a trending score and a short AI-written
//     summary of why each ticker is trending.
//
// This is a periodic pipeline (not a live per-request call from the app)
// for the same reason every other cache in this repo is: dozens/hundreds
// of app users hitting a small free community API directly, simultaneously,
// on every screen open would be a bad API citizen and offers no caching/
// offline benefit — one shared fetch every couple hours, published once,
// serves everyone.

const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, '../trendingSocialCache.json');
const APEWISDOM_URL = 'https://apewisdom.io/api/v1.0/filter/all-stocks';
const STOCKTWITS_URL = 'https://api.stocktwits.com/api/2/trending/symbols.json';
const MAX_RESULTS = 20;
// Fetched past MAX_RESULTS so a list still holds MAX_RESULTS companies after
// share-class duplicates are merged out (see mergeShareClasses).
const FETCH_RESULTS = 40;
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
// A CIK with more tickers than this is a fund trust filing for many
// unrelated ETFs (ProShares Trust II: UVXY, SVXY, UCO and 13 more), not one
// company's share classes -- those stay separate.
const MAX_SHARE_CLASSES_PER_CIK = 4;
const USER_AGENT = 'stock-analyzer-app smart-money-pipeline contact:jadrayescpp@gmail.com';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

// "all-stocks" filter (as opposed to the bare wallstreetbets-only default)
// covers stocks/investing/options/SPACs/Daytrading etc, not just meme-stock-
// heavy WSB — a broader, more representative "what's being discussed"
// signal for a general trending feature. Foreign/depositary-style tickers
// aren't filtered out here the way stockData.js filters search results —
// ApeWisdom's own mention-counting is already US-retail-Reddit-centric, so
// this is a non-issue in practice (verified live: results are overwhelmingly
// plain US tickers).
// ApeWisdom's `name` field comes back with raw HTML entities un-decoded
// (verified live: "SPDR S&amp;P 500 ETF Trust" for SPY) — only the common
// few that actually show up in fund/company names are handled, not a full
// HTML-entity decode (no need for the added complexity/dependency here).
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"');
}

async function fetchRedditTrending() {
  const data = await fetchJson(APEWISDOM_URL);
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.slice(0, FETCH_RESULTS).map((r) => ({
    rank: r.rank,
    symbol: r.ticker,
    name: decodeHtmlEntities(r.name),
    mentions: r.mentions,
    mentions24hAgo: r.mentions_24h_ago,
    upvotes: r.upvotes,
  }));
}

// This app covers stocks/REITs and ETFs, not crypto — StockTwits' trending
// feed mixes in 'CRYPTO', 'MISC', and 'PRIVATE' instrument classes
// alongside 'Stock'/'ExchangeTradedFund' (confirmed live), so this scopes
// the feed to what the rest of the app can actually do something useful
// with (tapping through to a Results/ETF Compare screen).
const STOCKTWITS_ALLOWED_CLASSES = new Set(['Stock', 'ExchangeTradedFund']);

function isTrackableInstrument(row) {
  return !!row?.symbol && STOCKTWITS_ALLOWED_CLASSES.has(row.instrument_class);
}

async function fetchStockTwitsTrending() {
  const data = await fetchJson(STOCKTWITS_URL);
  const results = Array.isArray(data?.symbols) ? data.symbols : [];
  return results
    .filter(isTrackableInstrument)
    .slice(0, FETCH_RESULTS)
    .map((r, i) => ({
      rank: i + 1,
      symbol: r.symbol,
      name: r.title,
      trendingScore: r.trending_score ?? null,
      watchlistCount: r.watchlist_count ?? null,
      summary: r.trends?.summary ?? null,
    }));
}

// ticker -> CIK, for tickers whose CIK has at most MAX_SHARE_CLASSES_PER_CIK
// tickers. Empty on failure: the lists then publish unmerged, as before.
async function fetchShareClassCiks() {
  try {
    const data = await fetchJson(SEC_TICKERS_URL);
    const tickersByCik = new Map();
    for (const { ticker, cik_str: cik } of Object.values(data || {})) {
      if (!tickersByCik.has(cik)) tickersByCik.set(cik, []);
      tickersByCik.get(cik).push(ticker);
    }
    const cikByTicker = new Map();
    for (const [cik, tickers] of tickersByCik) {
      if (tickers.length > MAX_SHARE_CLASSES_PER_CIK) continue;
      for (const t of tickers) cikByTicker.set(t, cik);
    }
    return cikByTicker;
  } catch (err) {
    console.log(`SEC ticker map fetch failed, share classes left unmerged: ${err.message}`);
    return new Map();
  }
}

// One row per company -- verified live: Reddit and StockTwits each listed
// GOOG and GOOGL as two separate trending entries. Keeps the better-ranked
// class's row as-is (its own counts, not a sum that might double-count a
// post naming both), drops the rest, and renumbers. SEC writes BRK.B as
// BRK-B; both spellings are looked up.
function mergeShareClasses(rows, cikByTicker) {
  if (!rows) return rows;
  const seen = new Set();
  const kept = [];
  for (const row of rows) {
    const symbol = String(row.symbol || '').toUpperCase();
    const cik = cikByTicker.get(symbol) ?? cikByTicker.get(symbol.replace('.', '-'));
    if (cik != null) {
      if (seen.has(cik)) continue;
      seen.add(cik);
    }
    kept.push(row);
  }
  return kept.slice(0, MAX_RESULTS).map((row, i) => ({ ...row, rank: i + 1 }));
}

async function main() {
  const cikByTickerPromise = fetchShareClassCiks();
  const [reddit, stocktwits] = await Promise.all([
    fetchRedditTrending().catch((err) => {
      console.log(`Reddit (ApeWisdom) fetch failed: ${err.message}`);
      return null;
    }),
    fetchStockTwitsTrending().catch((err) => {
      console.log(`StockTwits fetch failed: ${err.message}`);
      return null;
    }),
  ]);

  const cikByTicker = await cikByTickerPromise;
  const redditMerged = mergeShareClasses(reddit, cikByTicker);
  const stocktwitsMerged = mergeShareClasses(stocktwits, cikByTicker);

  // Merge-protective, same philosophy as every other cache in this repo:
  // a transient failure on one source shouldn't wipe out what was
  // previously published for it. Only overwrite a source's section when
  // this run actually got real data for it.
  let previous = { reddit: [], stocktwits: [] };
  try {
    // Cache-busting query param -- see generateSectorMetrics.js's
    // identical fix this session for the live-verified root cause:
    // GitHub's raw-gist CDN can serve a genuinely stale file minutes
    // after a real push.
    const res = await fetch(`https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/trendingSocialCache.json?_cb=${Date.now()}`);
    if (res.ok) previous = await res.json();
  } catch {
    // First-ever run, or the gist fetch failed — fall through with empty previous.
  }

  const output = {
    generatedAt: new Date().toISOString(),
    reddit: redditMerged ?? previous.reddit ?? [],
    stocktwits: stocktwitsMerged ?? previous.stocktwits ?? [],
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  console.log(`Done. Reddit: ${output.reddit.length} tickers. StockTwits: ${output.stocktwits.length} tickers.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
