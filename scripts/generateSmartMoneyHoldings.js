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
const { sleep, fetchJson, fetchText, fetchSubmissions, fetchWithTimeout } = require('./lib/secEdgar');

const OUTPUT_FILE = path.join(__dirname, '../smartMoneyHoldings.json');
const GIST_HOLDINGS_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/smartMoneyHoldings.json';
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/marketMetrics.json';
const OPENFIGI_URL = 'https://api.openfigi.com/v3/mapping';
const OPENFIGI_BATCH_SIZE = 10; // unauthenticated cap
const OPENFIGI_SPACING_MS = 2600; // keeps well under 25 req/min unauthenticated
const SEC_SPACING_MS = 200;

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
    const nameOfIssuer = block.match(/<[a-zA-Z0-9]*:?nameOfIssuer>([^<]+)<\/[a-zA-Z0-9]*:?nameOfIssuer>/i)?.[1]?.trim();
    const value = parseFloat(block.match(/<[a-zA-Z0-9]*:?value>([^<]+)<\/[a-zA-Z0-9]*:?value>/i)?.[1] || 'NaN');
    const shares = parseFloat(block.match(/<[a-zA-Z0-9]*:?sshPrnamt>([^<]+)<\/[a-zA-Z0-9]*:?sshPrnamt>/i)?.[1] || 'NaN');
    if (!cusip || Number.isNaN(value) || Number.isNaN(shares)) continue;
    // NOT multiplied by 1000 despite Form 13F's nominal "report value in
    // thousands" instruction — verified live against Berkshire's actual
    // latest filing: raw value/shares for its Ally Financial position
    // implies ~$39.23/share when taken as literal dollars (matches Ally's
    // real trading range), vs ~$39,230/share if treated as thousands
    // (impossible - exceeds Ally's entire market cap many times over).
    // Modern filers evidently report actual dollars in this field now.
    entries.push({ cusip, nameOfIssuer, value, shares });
  }
  return entries;
}

// Sums multiple sub-manager line items for the same CUSIP within one
// filing into a single position — verified live this is real and common
// (Berkshire's latest 13F: 6 separate Ally Financial entries).
function aggregateByCusip(entries) {
  const byCusip = new Map();
  for (const e of entries) {
    const existing = byCusip.get(e.cusip);
    if (existing) {
      existing.value += e.value;
      existing.shares += e.shares;
    } else {
      byCusip.set(e.cusip, { ...e });
    }
  }
  return Array.from(byCusip.values());
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
async function mapCusipsToTickers(cusips) {
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
        body: JSON.stringify(batch.map((c) => ({ idType: 'ID_CUSIP', idValue: c }))),
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
        if (preferred?.ticker) result.set(batch[idx], preferred.ticker.toUpperCase());
      });
    }
    await sleep(OPENFIGI_SPACING_MS);
  }
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
    if (!existing || !existing.reportPeriod || (fresh.reportPeriod && fresh.reportPeriod > existing.reportPeriod)) {
      merged[cik] = fresh;
    }
  }
  return merged;
}

async function fetchPreviouslyPublished() {
  try {
    const data = await fetchJson(GIST_HOLDINGS_URL);
    return data?.byFund && typeof data.byFund === 'object' ? data.byFund : {};
  } catch {
    return {};
  }
}

async function main() {
  console.log(`Fetching latest 13F-HR for ${FUND_ROSTER.length} tracked funds...`);
  const metricsDataset = await fetchJson(GIST_METRICS_URL);
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
  const cusipToTicker = await mapCusipsToTickers(Array.from(allCusips));
  console.log(`Resolved ${cusipToTicker.size} of ${allCusips.size} CUSIPs.`);

  const holdings = {};
  for (const fund of Object.values(merged)) {
    for (const p of fund.positions || []) {
      const ticker = cusipToTicker.get(p.cusip);
      if (!ticker || !coveredUniverse.has(ticker)) continue; // not a ticker this app ever looks up
      if (!holdings[ticker]) holdings[ticker] = [];
      holdings[ticker].push({
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

  const output = { generatedAt: new Date().toISOString(), byFund: merged, holdings };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  const tickerCount = Object.keys(holdings).length;
  console.log(`Done. ${tickerCount} tickers have at least one tracked holder.`);
}

module.exports = { parseInfoTable, aggregateByCusip, pickHoldingsToPublish, mapCusipsToTickers, FUND_ROSTER };

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
