// scripts/generateInsiderActivity.js
//
// Publishes recent (~30 day) insider Form 4 activity per ticker, across the
// FULL covered universe (not a curated roster — unlike the 13F half of
// this repo, every issuer files its own Form 4s, and SEC exposes them
// directly under the issuer's own CIK — verified live this session against
// Apple's own submissions feed before writing this).
//
// Filtered to open-market buys/sells (transaction codes P and S) only —
// verified live against a real, current Apple Form 4: the same filing
// mixed a routine RSU-vesting settlement (code M) and the resulting tax-
// withholding share surrender (code F) alongside the real transactions,
// and neither reflects a discretionary buy/sell decision an insider made.
// Publishing those alongside P/S would bury the real signal in routine
// compensation mechanics for most tickers, most of the time.

const fs = require('fs');
const path = require('path');
const { sleep, fetchJson, fetchText, fetchTickerToCikMap, fetchSubmissions } = require('./lib/secEdgar');

const OUTPUT_FILE = path.join(__dirname, '../insiderActivityCache.json');
const GIST_ACTIVITY_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/insiderActivityCache.json';
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/db6fbd96e980118d3c6a63965dc0dc39/raw/marketMetrics.json';
const SEC_SPACING_MS = 150;
const LOOKBACK_DAYS = 35; // a few days of slack past the 30-day window SEC requires Form 4 filing within
const RETENTION_DAYS = 30; // published window shown to users

// Open-market purchase/sale only — see file header. Every other code (A
// grant, F tax withholding, M/X option exercise, C conversion, G gift,
// etc.) reflects routine compensation mechanics or a non-market transfer,
// not a discretionary trading decision.
const SIGNAL_CODES = new Set(['P', 'S']);

function daysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

// Form 4 XML is simple, flat, repeating structure like the 13F info table
// — same lightweight regex-extraction approach as generateSmartMoneyHoldings.js,
// verified live against a real current Apple Form 4 before writing this.
function parseForm4(xml) {
  const issuerTicker = xml.match(/<issuerTradingSymbol>([^<]*)<\/issuerTradingSymbol>/i)?.[1]?.trim();
  const ownerName = xml.match(/<rptOwnerName>([^<]*)<\/rptOwnerName>/i)?.[1]?.trim();
  const isOfficer = /<isOfficer>\s*1|true\s*<\/isOfficer>/i.test(xml);
  const isDirector = /<isDirector>\s*1|true\s*<\/isDirector>/i.test(xml);
  const isTenPercentOwner = /<isTenPercentOwner>\s*1|true\s*<\/isTenPercentOwner>/i.test(xml);
  const officerTitle = xml.match(/<officerTitle>([^<]*)<\/officerTitle>/i)?.[1]?.trim() || null;

  const transactions = [];
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/gi) || [];
  for (const block of blocks) {
    const transactionDate = block.match(/<transactionDate>\s*<value>([^<]+)<\/value>/i)?.[1]?.trim();
    const transactionCode = block.match(/<transactionCode>([^<]+)<\/transactionCode>/i)?.[1]?.trim();
    const shares = parseFloat(block.match(/<transactionShares>\s*<value>([^<]+)<\/value>/i)?.[1] || 'NaN');
    // A footnote reference (not a literal price) sometimes stands in for
    // price — verified live: Apple's option-exercise line used
    // <footnoteId id="F1"/> instead of a <value>. Left null rather than
    // guessed.
    const priceMatch = block.match(/<transactionPricePerShare>\s*<value>([^<]+)<\/value>/i);
    const price = priceMatch ? parseFloat(priceMatch[1]) : null;
    const acquiredDisposed = block.match(/<transactionAcquiredDisposedCode>\s*<value>([^<]+)<\/value>/i)?.[1]?.trim();
    const sharesOwnedAfter = parseFloat(block.match(/<sharesOwnedFollowingTransaction>\s*<value>([^<]+)<\/value>/i)?.[1] || 'NaN');
    if (!transactionDate || !transactionCode || Number.isNaN(shares)) continue;
    if (!SIGNAL_CODES.has(transactionCode)) continue;
    transactions.push({
      transactionDate,
      transactionCode,
      sharesTransacted: shares,
      pricePerShare: price,
      acquiredDisposed: acquiredDisposed || null,
      sharesOwnedAfter: Number.isNaN(sharesOwnedAfter) ? null : sharesOwnedAfter,
    });
  }
  if (!transactions.length) return null;
  return { issuerTicker, ownerName, isOfficer, isDirector, isTenPercentOwner, officerTitle, transactions };
}

async function fetchRecentForm4Filings(cik, sinceDate) {
  const submissions = await fetchSubmissions(cik);
  if (!submissions?.filings?.recent) return [];
  const r = submissions.filings.recent;
  const filings = [];
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] !== '4') continue;
    if (new Date(r.filingDate[i]) < sinceDate) break; // recent[] is filing-date descending — safe to stop early
    filings.push({ accessionNumber: r.accessionNumber[i], filingDate: r.filingDate[i] });
  }
  return filings;
}

function form4XmlUrl(cik, accessionNumber) {
  const accessionNoDashes = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/form4.xml`;
}

// Union fresh entries with still-within-RETENTION_DAYS previously-published
// ones, deduped by (cik, transactionDate, transactionCode, sharesTransacted)
// — a transient per-ticker SEC fetch failure in one run shouldn't wipe that
// ticker's real recent activity, but activity aging out of the window
// should still drop off rather than accumulate forever.
function mergeTransactions(existing, fresh, cutoffDate) {
  const key = (t) => `${t.cik}|${t.transactionDate}|${t.transactionCode}|${t.sharesTransacted}`;
  const byKey = new Map();
  for (const t of existing || []) {
    if (new Date(t.transactionDate) >= cutoffDate) byKey.set(key(t), t);
  }
  for (const t of fresh || []) {
    byKey.set(key(t), t);
  }
  return Array.from(byKey.values()).sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate));
}

async function fetchPreviouslyPublished() {
  try {
    const data = await fetchJson(GIST_ACTIVITY_URL);
    return data?.transactions && typeof data.transactions === 'object' ? data.transactions : {};
  } catch {
    return {};
  }
}

async function main() {
  const metricsDataset = await fetchJson(GIST_METRICS_URL);
  const coveredTickers = Object.keys(metricsDataset?.metrics || {});
  console.log(`Covered universe: ${coveredTickers.length} tickers.`);

  const tickerToCik = await fetchTickerToCikMap();
  const previouslyPublished = await fetchPreviouslyPublished();
  const sinceDate = daysAgo(LOOKBACK_DAYS);
  const cutoffDate = daysAgo(RETENTION_DAYS);

  const freshByTicker = {};
  let scanned = 0;
  let withActivity = 0;

  for (const ticker of coveredTickers) {
    const cik = tickerToCik.get(ticker);
    scanned++;
    if (!cik) continue;
    try {
      const filings = await fetchRecentForm4Filings(cik, sinceDate);
      await sleep(SEC_SPACING_MS);
      if (!filings.length) continue;

      const transactions = [];
      for (const filing of filings) {
        const xml = await fetchText(form4XmlUrl(cik, filing.accessionNumber));
        await sleep(SEC_SPACING_MS);
        if (!xml) continue;
        const parsed = parseForm4(xml);
        if (!parsed) continue;
        for (const t of parsed.transactions) {
          transactions.push({
            cik,
            insiderName: parsed.ownerName,
            isOfficer: parsed.isOfficer,
            isDirector: parsed.isDirector,
            isTenPercentOwner: parsed.isTenPercentOwner,
            officerTitle: parsed.officerTitle,
            ...t,
            filedAt: filing.filingDate,
          });
        }
      }
      if (transactions.length) {
        freshByTicker[ticker] = transactions;
        withActivity++;
      }
    } catch (err) {
      console.log(`  ${ticker}: failed (${err.message})`);
    }
    if (scanned % 250 === 0) console.log(`  ...scanned ${scanned}/${coveredTickers.length}, ${withActivity} with signal activity so far`);
  }

  const merged = {};
  const allTickers = new Set([...Object.keys(previouslyPublished), ...Object.keys(freshByTicker)]);
  for (const ticker of allTickers) {
    const result = mergeTransactions(previouslyPublished[ticker], freshByTicker[ticker], cutoffDate);
    if (result.length) merged[ticker] = result;
  }

  const output = { generatedAt: new Date().toISOString(), transactions: merged };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  console.log(`Done. ${Object.keys(merged).length} tickers have recent signal insider activity.`);
}

module.exports = { parseForm4, mergeTransactions, SIGNAL_CODES };

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
