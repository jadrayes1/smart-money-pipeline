// scripts/generateSmartMoneyHoldings.js
//
// Publishes, per ticker, which tracked well-known investors currently hold
// it — sourced from SEC 13F-HR filings (free, quarterly, ~45 days after
// quarter-end). Runs against a small, fixed, hand-verified roster of fund
// CIKs (see FUND_ROSTER below) rather than an auto-discovered universe —
// there's no free crosswalk from "investor name" to CIK, and guessing
// would risk silently pulling the wrong fund's data.
//
// Two real wrinkles handled here, both verified live against Berkshire
// Hathaway's actual latest 13F-HR before writing this:
//   1. A single filing can list the SAME issuer/CUSIP across MULTIPLE
//      infoTable entries (one per sub-manager, via the otherManager
//      field) — verified live: Berkshire's latest 13F has 6 separate
//      entries for Ally Financial alone. These must be SUMMED per CUSIP
//      within a filing, not treated as 6 separate positions.
//   2. 13F filings report holdings by CUSIP, not ticker — there's no free
//      official crosswalk from SEC directly. Resolved via OpenFIGI
//      (openfigi.com/api), a free Bloomberg-run mapping API built for
//      exactly this. Run keyless (25 req/min, 10 CUSIPs/request) — plenty
//      for this roster's realistically-low-thousands de-duped CUSIP count.

const fs = require('fs');
const path = require('path');
const { sleep, fetchJson, fetchText, fetchSubmissions, fetchWithTimeout, decodeXmlEntities } = require('./lib/secEdgar');

const OUTPUT_FILE = path.join(__dirname, '../smartMoneyHoldings.json');
const GIST_HOLDINGS_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/smartMoneyHoldings.json';
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/marketMetrics.json';
const OPENFIGI_URL = 'https://api.openfigi.com/v3/mapping';
const OPENFIGI_BATCH_SIZE = 10; // unauthenticated cap
const OPENFIGI_SPACING_MS = 2600; // keeps well under 25 req/min unauthenticated
const SEC_SPACING_MS = 200;
// A real US common-stock ticker: 1-5 letters, optionally with a single
// "."/"-" share-class suffix (e.g. "BRK.A"/"BRK-B") -- see
// mapCusipsToTickers' own comment for why this rejects OpenFIGI's foreign-
// cross-listing suffix convention ("EA*", "LEG1*") rather than trying to
// strip it back to the real ticker.
const VALID_TICKER_FORMAT = /^[A-Z]{1,5}([.-][A-Z])?$/;

// Confirmed via LIVE SEC EDGAR lookups (not recalled from memory — a wrong
// CIK silently pulls the wrong fund's data). Cross-checked by which entity
// actually has a RECENT 13F-HR filing, not just a name match — this
// corrected two real errors versus an earlier, unverified draft roster:
//   - Trian: the GP entity (CIK 0001345472) stopped filing 13Fs in 2011;
//     the real active filer is Trian Fund Management, L.P. (0001345471).
//   - Icahn: Icahn Enterprises L.P. (0000813762) has never filed a 13F;
//     the real active filer is Carl C. Icahn personally (0000921669).
const FUND_ROSTER = [
  { investor: 'Warren Buffett', fundName: 'Berkshire Hathaway Inc', cik: '0001067983' },
  { investor: 'Michael Burry', fundName: 'Scion Asset Management, LLC', cik: '0001649339' },
  { investor: 'Bill Ackman', fundName: 'Pershing Square Capital Management, L.P.', cik: '0001336528' },
  { investor: 'Ray Dalio', fundName: 'Bridgewater Associates', cik: '0001350694' },
  { investor: 'Jim Simons', fundName: 'Renaissance Technologies LLC', cik: '0001037389' },
  { investor: 'David Einhorn', fundName: 'Greenlight Capital Inc', cik: '0001079114' },
  { investor: 'Dan Loeb', fundName: 'Third Point LLC', cik: '0001040273' },
  { investor: 'Seth Klarman', fundName: 'Baupost Group LLC/MA', cik: '0001061768' },
  { investor: 'Stanley Druckenmiller', fundName: 'Duquesne Family Office LLC', cik: '0001536411' },
  { investor: 'David Tepper', fundName: 'Appaloosa LP', cik: '0001656456' },
  { investor: 'George Soros', fundName: 'Soros Fund Management LLC', cik: '0001029160' },
  { investor: 'Ken Griffin', fundName: 'Citadel Advisors LLC', cik: '0001423053' },
  { investor: 'Steve Cohen', fundName: 'Point72 Asset Management, L.P.', cik: '0001603466' },
  { investor: 'Chase Coleman', fundName: 'Tiger Global Management LLC', cik: '0001167483' },
  { investor: 'Andreas Halvorsen', fundName: 'Viking Global Investors LP', cik: '0001103804' },
  { investor: 'Philippe Laffont', fundName: 'Coatue Management LLC', cik: '0001135730' },
  { investor: 'Carl Icahn', fundName: 'Icahn Carl C', cik: '0000921669' },
  { investor: 'Cathie Wood', fundName: 'ARK Investment Management LLC', cik: '0001697748' },
  { investor: 'Nelson Peltz', fundName: 'Trian Fund Management, L.P.', cik: '0001345471' },
  { investor: 'Stephen Mandel', fundName: 'Lone Pine Capital LLC', cik: '0001061165' },
  { investor: 'Paul Singer', fundName: 'Elliott Investment Management L.P.', cik: '0001791786' },
  { investor: 'Andrew Spokes', fundName: 'Farallon Capital Management, L.L.C.', cik: '0000909661' },
  { investor: 'Dan Sundheim', fundName: "D1 Capital Partners L.P.", cik: '0001747057' },
];

async function fetchFilingDocumentUrls(cik, accessionNumber) {
  const accessionNoDashes = accessionNumber.replace(/-/g, '');
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/`;
  const html = await fetchText(indexUrl);
  if (!html) return [];
  const hrefs = [...html.matchAll(/href="([^"]+\.xml)"/gi)].map((m) => m[1]);
  return hrefs
    .filter((h) => !/primary_doc\.xml$/i.test(h)) // the cover page, never the holdings table
    .map((h) => (h.startsWith('http') ? h : `https://www.sec.gov${h}`));
}

// Info tables are simple, flat, repeating XML generated by SEC's own
// filer tooling — a lightweight regex extraction avoids adding an XML-
// parsing dependency for a structure this consistent (unlike the
// free-text filing HTML the foreign-filings-pipeline repo has to parse).
function parseInfoTable(xml) {
  // Optional XML namespace prefix on every tag — verified live: Bridgewater's
  // (and, it turns out, several other funds') infoTable.xml wraps every
  // element as <ns1:infoTable>/<ns1:cusip>/etc, unlike Berkshire's bare
  // <infoTable>/<cusip>. A bare-tag-only regex silently matched zero blocks
  // for every namespaced filing — the root cause of Dalio/Loeb/Klarman/
  // Halvorsen/Peltz all showing 0 positions despite each having a real,
  // recent 13F-HR filing. `[a-zA-Z0-9]*:?` matches both shapes.
  const entries = [];
  const blocks = xml.match(/<[a-zA-Z0-9]*:?infoTable>[\s\S]*?<\/[a-zA-Z0-9]*:?infoTable>/gi) || [];
  for (const block of blocks) {
    const cusip = block.match(/<[a-zA-Z0-9]*:?cusip>([^<]+)<\/[a-zA-Z0-9]*:?cusip>/i)?.[1]?.trim();
    // Same naive regex-extraction gap as generateInsiderActivity.js's Form 4
    // text fields -- verified live: Ken Griffin's (Citadel's) latest 13F
    // lists "STATE STR SPDR S&amp;P 500 ETF T" verbatim, the raw XML entity
    // never decoded. Previously left unfixed here on the (now outdated)
    // assumption that nameOfIssuer was never actually displayed anywhere --
    // it is now, via the new smart-money fund profile screen's top-10-
    // holdings list (see fetchSmartMoneyFundProfile in stock-analyzer).
    const nameOfIssuer = decodeXmlEntities(block.match(/<[a-zA-Z0-9]*:?nameOfIssuer>([^<]+)<\/[a-zA-Z0-9]*:?nameOfIssuer>/i)?.[1]?.trim());
    const value = parseFloat(block.match(/<[a-zA-Z0-9]*:?value>([^<]+)<\/[a-zA-Z0-9]*:?value>/i)?.[1] || 'NaN');
    const shares = parseFloat(block.match(/<[a-zA-Z0-9]*:?sshPrnamt>([^<]+)<\/[a-zA-Z0-9]*:?sshPrnamt>/i)?.[1] || 'NaN');
    if (!cusip || Number.isNaN(value) || Number.isNaN(shares)) continue;
    // Verified live (Soros, period 2026-06-30): four of the fund's top-10
    // positions are convertible NOTES ("NOTE 1.500% 3/0", amountType PRN --
    // principal dollars, not shares) and its Rivian common row is actually
    // a CALL option. Without these three fields the app showed "247,500,000
    // shares" for a $247.5M note and treated an option as stock.
    const titleOfClass = decodeXmlEntities(block.match(/<[a-zA-Z0-9]*:?titleOfClass>([^<]+)<\/[a-zA-Z0-9]*:?titleOfClass>/i)?.[1]?.trim()) || null;
    const amountType = block.match(/<[a-zA-Z0-9]*:?sshPrnamtType>([^<]+)<\/[a-zA-Z0-9]*:?sshPrnamtType>/i)?.[1]?.trim().toUpperCase() || null;
    const putCall = block.match(/<[a-zA-Z0-9]*:?putCall>([^<]+)<\/[a-zA-Z0-9]*:?putCall>/i)?.[1]?.trim() || null;
    // NOT multiplied by 1000 despite Form 13F's nominal "report value in
    // thousands" instruction — verified live against Berkshire's actual
    // latest filing: raw value/shares for its Ally Financial position
    // implies ~$39.23/share when taken as literal dollars (matches Ally's
    // real trading range), vs ~$39,230/share if treated as thousands
    // (impossible - exceeds Ally's entire market cap many times over).
    // Modern filers evidently report actual dollars in this field now.
    const entry = { cusip, nameOfIssuer, value, shares };
    if (titleOfClass) entry.titleOfClass = titleOfClass;
    if (amountType === 'PRN') entry.amountType = 'PRN';
    if (putCall) entry.putCall = putCall;
    entries.push(entry);
  }
  return entries;
}

// Sums multiple sub-manager line items for the same CUSIP within one
// filing into a single position — verified live this is real and common
// (Berkshire's latest 13F: 6 separate Ally Financial entries).
function isCommonStockPosition(p) {
  return p.amountType !== 'PRN' && !p.putCall;
}

// A CUSIP's first 6 characters identify its ISSUER, so a convertible note
// (76954AAB9) shares an issuer code with that company's common stock
// (76954A103 -> RIVN). Only used when the code maps to exactly one equity
// ticker in this dataset -- Alphabet's 02079K covers both GOOG and GOOGL,
// so a note under it falls through to the bond-ticker fallback instead.
function attachTickers(merged, cusipInfo) {
  const tickersByIssuer = new Map();
  for (const [cusip, info] of cusipInfo) {
    if (!info.ticker) continue;
    const issuer = cusip.slice(0, 6);
    if (!tickersByIssuer.has(issuer)) tickersByIssuer.set(issuer, new Set());
    tickersByIssuer.get(issuer).add(info.ticker);
  }
  for (const fund of Object.values(merged)) {
    for (const p of fund.positions || []) {
      const info = cusipInfo.get(p.cusip);
      let ticker = info?.ticker || null;
      if (!ticker && p.amountType === 'PRN') {
        const issuerTickers = tickersByIssuer.get(p.cusip.slice(0, 6));
        ticker = issuerTickers?.size === 1 ? [...issuerTickers][0] : info?.issuerTicker || null;
      }
      p.ticker = ticker;
    }
  }
}

// Keyed on putCall too: an option is reported under its UNDERLYING's CUSIP,
// so a fund holding both the stock and calls on it would otherwise have the
// option's underlying-share count summed into the stock row.
function aggregateByCusip(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const key = `${e.cusip}|${e.putCall || ''}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.value += e.value;
      existing.shares += e.shares;
    } else {
      byKey.set(key, { ...e });
    }
  }
  return Array.from(byKey.values());
}

async function fetchLatest13F(cik) {
  const submissions = await fetchSubmissions(cik);
  if (!submissions?.filings?.recent) return null;
  const r = submissions.filings.recent;
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] === '13F-HR') {
      return {
        accessionNumber: r.accessionNumber[i],
        filingDate: r.filingDate[i],
        reportPeriod: r.reportDate ? r.reportDate[i] : null,
      };
    }
  }
  return null;
}

// Batched, keyless OpenFIGI CUSIP->ticker mapping. Prefers the primary US
// common-stock listing (marketSector "Equity", exchCode "US") when a CUSIP
// maps to several exchange listings — verified live: a single US CUSIP
// (Apple's) returns ~4 near-duplicate rows differing only by exchCode.
async function mapIdsToTickers(cusips, idType) {
  const result = new Map();
  for (let i = 0; i < cusips.length; i += OPENFIGI_BATCH_SIZE) {
    const batch = cusips.slice(i, i + OPENFIGI_BATCH_SIZE);
    let res;
    try {
      // fetchWithTimeout (30s ceiling) rather than a bare fetch — verified
      // live this matters: a run once stalled at 0% CPU for 5+ hours,
      // apparently a single OpenFIGI request left hanging after a
      // connectivity blip mid-run, with no error and no timeout to abort it.
      res = await fetchWithTimeout(OPENFIGI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch.map((c) => ({ idType, idValue: c }))),
      });
    } catch {
      await sleep(OPENFIGI_SPACING_MS);
      continue;
    }
    if (res.ok) {
      const body = await res.json();
      body.forEach((entry, idx) => {
        const rows = entry?.data;
        if (!Array.isArray(rows) || !rows.length) return;
        const preferred = rows.find((r) => r.marketSector === 'Equity' && r.exchCode === 'US') || rows.find((r) => r.marketSector === 'Equity');
        // Verified live: Electronic Arts (CUSIP 285512109) has NO row at all
        // with exchCode === 'US' -- the "preferred US" filter above falls
        // through to the bare marketSector fallback, which lands on a
        // Mexican BMV cross-listing, "EA*" (OpenFIGI's own convention of
        // appending "*" -- sometimes with an extra disambiguating digit
        // too, e.g. Leggett & Platt's "LEG1*" for its real ticker "LEG" --
        // for a US stock's secondary foreign listing). Every one of 8
        // distinct tickers audited live in the current published dataset
        // had this exact shape, and OpenFIGI offers no clean alternative
        // for ANY of them via this CUSIP lookup -- there is no reliable
        // way to strip this back to the real ticker from the string alone
        // (stripping just "*" would wrongly leave "LEG1"). Rejecting the
        // whole match (VALID_TICKER_FORMAT) rather than guessing keeps
        // this ticker-less, same as any other unmapped CUSIP -- the app
        // already renders that correctly as a plain, non-broken card (see
        // SmartMoneyProfileScreen's own p.ticker ? TouchableOpacity : View
        // convention) instead of a card that LOOKS clickable but navigates
        // to a symbol that doesn't exist.
        const ticker = preferred?.ticker?.toUpperCase();
        // A convertible note's CUSIP has no equity row at all, but OpenFIGI's
        // bond ticker leads with the issuer's own stock ticker (Bloomberg
        // convention) -- verified live: 76954AAB9 -> "RIVN 4.625 03/15/29",
        // 69331CAL2 -> "PCG 4.25 12/01/27", 090043AF7 -> "BILL 0 04/01/30".
        // Only a fallback: main() prefers the CUSIP issuer-code match first.
        const corpRow = preferred ? null : rows.find((r) => r.marketSector === 'Corp');
        const bondIssuerTicker = corpRow?.ticker?.split(' ')[0]?.toUpperCase();
        result.set(batch[idx], {
          ticker: ticker && VALID_TICKER_FORMAT.test(ticker) ? ticker : null,
          issuerTicker: bondIssuerTicker && VALID_TICKER_FORMAT.test(bondIssuerTicker) ? bondIssuerTicker : null,
        });
      });
    }
    await sleep(OPENFIGI_SPACING_MS);
  }
  return result;
}

// A 13F reports a FOREIGN-domiciled issuer under its CINS identifier (the
// CUSIP International Numbering System), which looks like a CUSIP but
// starts with a letter encoding the domicile -- G for the UK and Channel
// Islands, N for the Netherlands, H for Switzerland, and so on. OpenFIGI's
// ID_CUSIP lookup rejects every one of them outright ("No identifier
// found."), so the position silently lost its ticker: no clickable card, no
// row in the per-ticker holder index, and no contribution to portfolio YTD.
//
// This is not a long-tail problem. Measured live against the published
// dataset: 598 of the 809 distinct unresolved common-stock CUSIPs (74%)
// were CINS, and they are ordinary large US-listed names -- Chubb
// (H1467J104 -> CB), AerCap (N00985106 -> AER), Amcor, Amdocs, Aon, Aptiv,
// Arch Capital, ASML, CRH. A 20-CUSIP sample re-queried under ID_CINS
// resolved 20 of 20 to a valid US ticker.
//
// Retrying under ID_CINS costs one extra batched pass over ONLY the CUSIPs
// the first pass failed to resolve, and cannot change any CUSIP the first
// pass already answered.
async function mapCusipsToTickers(cusips) {
  const result = await mapIdsToTickers(cusips, 'ID_CUSIP');
  const unresolved = cusips.filter((c) => {
    const hit = result.get(c);
    return !hit || (!hit.ticker && !hit.issuerTicker);
  });
  if (!unresolved.length) return result;

  const viaCins = await mapIdsToTickers(unresolved, 'ID_CINS');
  let recovered = 0;
  for (const [cusip, hit] of viaCins) {
    if (!hit || (!hit.ticker && !hit.issuerTicker)) continue;
    result.set(cusip, hit);
    recovered++;
  }
  console.log(`  OpenFIGI: ${unresolved.length} CUSIP(s) unresolved by ID_CUSIP, ${recovered} recovered via ID_CINS.`);
  return result;
}

// A fresh run with fewer holdings for a fund than previously published
// only overwrites if it has a newer reportPeriod — a transient SEC hiccup
// (fetch failure, empty parse) shouldn't erase real prior data. Mirrors
// pickTrendToPublish's reasoning in the other two pipelines' scripts.
function pickHoldingsToPublish(existingByFund, freshByFund) {
  const merged = { ...existingByFund };
  for (const [cik, fresh] of Object.entries(freshByFund)) {
    const existing = existingByFund[cik];
    // Same period counts too, as long as the fresh parse isn't empty -- it's
    // a re-parse of the same filing, so a parser fix must be able to replace
    // it. Verified live: with strict ">" the convertible-note fix re-parsed
    // Soros's 2026-06-30 13F correctly, then discarded it for the stale
    // cached copy of that same filing.
    const freshUsable = (fresh.positions || []).length > 0;
    if (!existing || !existing.reportPeriod || (fresh.reportPeriod && freshUsable && fresh.reportPeriod >= existing.reportPeriod)) {
      merged[cik] = fresh;
    }
  }
  return merged;
}

// Cache-busting query param (not a change to fetchJson itself, shared
// with Twelve Data calls that don't need it) -- see generateSectorMetrics
// .js's identical fix this session for the live-verified root cause:
// GitHub's raw-gist CDN can serve a genuinely stale file minutes after a
// real push.
async function fetchPreviouslyPublished() {
  try {
    const data = await fetchJson(`${GIST_HOLDINGS_URL}?_cb=${Date.now()}`);
    return data?.byFund && typeof data.byFund === 'object' ? data.byFund : {};
  } catch {
    return {};
  }
}

const TWELVEDATA_REQUEST_SPACING_MS = 8000; // mirrors stock-metrics-pipeline/generatePfcfTrendCache.js's own pacing — ~7.5/min, under Twelve Data's free-tier 8/min cap

// One call per distinct ticker returns BOTH the current price and a real
// year-start anchor (the monthly interval naturally includes a bar at/near
// Jan 1) -- no separate "price on date X" lookup needed. outputsize=14
// comfortably covers back past January even when run in December.
async function fetchMonthlyCloses(symbol, apiKey) {
  const data = await fetchJson(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1month&outputsize=14&apikey=${apiKey}`);
  if (data?.status !== 'ok' || !Array.isArray(data.values)) return [];
  return data.values
    .map((v) => ({ date: v.datetime, close: parseFloat(v.close) }))
    .filter((v) => !Number.isNaN(v.close))
    .sort((a, b) => new Date(a.date) - new Date(b.date)); // ascending -- Twelve Data returns newest-first
}

// Mutates each fund in `merged`, adding `portfolioYtd: { value, asOfDate,
// basedOnPositions }` (or leaving it absent on any failure/no-key, same
// graceful-degradation philosophy as every other optional field in these
// pipelines -- a profile screen with no YTD figure is better than one
// that's silently wrong). Deliberately an APPROXIMATION, disclosed as such
// via basedOnPositions: computed only from each fund's own top 10
// positions BY VALUE (not the full portfolio -- bounds the Twelve Data
// budget to a knowable ceiling regardless of roster size), and assumes
// the CURRENT share count was held for the whole year (13F only discloses
// a point-in-time snapshot, never intra-year trading) -- the same
// "current holdings, applied backward" convention retail portfolio
// trackers commonly use when real cost-basis/trade-date data isn't
// available, not a precision performance-attribution figure.
async function attachPortfolioYtd(merged) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    console.log('  TWELVEDATA_API_KEY not set -- skipping portfolio YTD (every other field still publishes normally).');
    return;
  }

  const topTenByFund = new Map();
  const allTickers = new Set();
  for (const [cik, fund] of Object.entries(merged)) {
    // Shares-weighted, so only real common-stock rows -- a note's `shares`
    // is principal dollars and an option's is underlying shares.
    const topTen = [...(fund.positions || [])]
      .filter((p) => p.ticker && isCommonStockPosition(p))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
    topTenByFund.set(cik, topTen);
    for (const p of topTen) allTickers.add(p.ticker);
  }

  console.log(`  Fetching monthly prices for ${allTickers.size} distinct top-10-holding tickers (portfolio YTD)...`);
  const closesByTicker = new Map();
  for (const ticker of allTickers) {
    try {
      closesByTicker.set(ticker, await fetchMonthlyCloses(ticker, apiKey));
    } catch (err) {
      console.log(`    ${ticker}: price fetch failed (${err.message})`);
    }
    await sleep(TWELVEDATA_REQUEST_SPACING_MS);
  }

  const currentYear = new Date().getUTCFullYear();
  for (const [cik, fund] of Object.entries(merged)) {
    const topTen = topTenByFund.get(cik) || [];
    let startValue = 0;
    let currentValue = 0;
    let used = 0;
    let latestAsOf = null;
    for (const p of topTen) {
      const closes = closesByTicker.get(p.ticker);
      if (!closes || closes.length < 2) continue;
      // Year-start anchor: the last bar dated in the PRIOR year (closing
      // price going into the current year) -- the conventional YTD
      // baseline. Falls back to the earliest bar in the CURRENT year
      // (e.g. a ticker that IPO'd after last year-end) rather than
      // skipping the position entirely.
      const priorYearBars = closes.filter((c) => new Date(c.date).getUTCFullYear() < currentYear);
      const startBar = priorYearBars.length ? priorYearBars[priorYearBars.length - 1] : closes[0];
      const latestBar = closes[closes.length - 1];
      if (!startBar || !latestBar || startBar === latestBar) continue;
      startValue += p.shares * startBar.close;
      currentValue += p.shares * latestBar.close;
      used++;
      if (!latestAsOf || latestBar.date > latestAsOf) latestAsOf = latestBar.date;
    }
    if (used > 0 && startValue > 0) {
      fund.portfolioYtd = { value: currentValue / startValue - 1, asOfDate: latestAsOf, basedOnPositions: used };
    }
  }
}

async function main() {
  console.log(`Fetching latest 13F-HR for ${FUND_ROSTER.length} tracked funds...`);
  const metricsDataset = await fetchJson(`${GIST_METRICS_URL}?_cb=${Date.now()}`);
  const coveredUniverse = new Set(Object.keys(metricsDataset?.metrics || {}));
  console.log(`Covered universe: ${coveredUniverse.size} tickers.`);

  const previouslyPublished = await fetchPreviouslyPublished();
  const freshByFund = {};

  for (const fund of FUND_ROSTER) {
    try {
      const latest = await fetchLatest13F(fund.cik);
      await sleep(SEC_SPACING_MS);
      if (!latest) {
        console.log(`  ${fund.investor}: no 13F-HR found`);
        continue;
      }
      const docUrls = await fetchFilingDocumentUrls(fund.cik, latest.accessionNumber);
      await sleep(SEC_SPACING_MS);
      let entries = [];
      for (const url of docUrls) {
        const xml = await fetchText(url);
        await sleep(SEC_SPACING_MS);
        if (!xml) continue;
        // Was `!xml.includes('<infoTable>')` — the same bare-tag bug fixed
        // in parseInfoTable's own regex above, just missed here on first
        // pass: this pre-check silently skipped every namespaced document
        // (<ns1:infoTable>, verified live for Bridgewater/Third Point/
        // Baupost/Viking/Trian) before parseInfoTable ever ran. Removed —
        // parseInfoTable already returns [] safely on a non-matching doc,
        // so this was a redundant, and here actively harmful, optimization.
        entries = parseInfoTable(xml);
        if (entries.length) break;
      }
      const aggregated = aggregateByCusip(entries);
      console.log(`  ${fund.investor}: ${aggregated.length} positions as of ${latest.reportPeriod || latest.filingDate}`);
      freshByFund[fund.cik] = { ...fund, ...latest, positions: aggregated };
    } catch (err) {
      console.log(`  ${fund.investor}: failed (${err.message})`);
    }
  }

  const merged = pickHoldingsToPublish(previouslyPublished, freshByFund);

  const allCusips = new Set();
  for (const fund of Object.values(merged)) {
    for (const p of fund.positions || []) allCusips.add(p.cusip);
  }
  console.log(`Mapping ${allCusips.size} distinct CUSIPs to tickers via OpenFIGI...`);
  const cusipInfo = await mapCusipsToTickers(Array.from(allCusips));
  console.log(`Resolved ${cusipInfo.size} of ${allCusips.size} CUSIPs.`);

  // Attached onto each position's OWN entry here -- previously
  // cusipToTicker only ever fed the ticker-keyed `holdings` inversion
  // below (and only for tickers in this app's own covered universe); a
  // fund's full `positions` list (used for a per-fund profile view, e.g.
  // "this investor's top 10 holdings") had no ticker at all, just a raw
  // nameOfIssuer string, with no way to look up a live price for it or
  // link it to the ticker's own screen. Deliberately NOT filtered by
  // coveredUniverse the way `holdings` is -- a fund's real #1 holding
  // should still show up in ITS OWN profile even if this app doesn't
  // separately track that ticker elsewhere.
  attachTickers(merged, cusipInfo);

  const holdings = {};
  for (const fund of Object.values(merged)) {
    for (const p of fund.positions || []) {
      if (!p.ticker || !coveredUniverse.has(p.ticker)) continue; // not a ticker this app ever looks up
      // The stock screen's carousel reads `shares` as common shares -- a
      // note's is principal dollars, an option's is underlying shares.
      if (!isCommonStockPosition(p)) continue;
      if (!holdings[p.ticker]) holdings[p.ticker] = [];
      holdings[p.ticker].push({
        investor: fund.investor,
        fundName: fund.fundName,
        fundCik: fund.cik,
        shares: p.shares,
        valueUsd: p.value,
        reportPeriod: fund.reportPeriod,
        filedAt: fund.filingDate,
      });
    }
  }

  await attachPortfolioYtd(merged);

  const output = { generatedAt: new Date().toISOString(), byFund: merged, holdings };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  const tickerCount = Object.keys(holdings).length;
  console.log(`Done. ${tickerCount} tickers have at least one tracked holder.`);
}

module.exports = { parseInfoTable, aggregateByCusip, pickHoldingsToPublish, mapCusipsToTickers, attachTickers, attachPortfolioYtd, isCommonStockPosition, FUND_ROSTER };

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
