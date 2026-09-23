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
const GIST_ACTIVITY_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/insiderActivityCache.json';
const GIST_METRICS_URL = 'https://gist.githubusercontent.com/jadrayes1/5cd7f459788725521246717b9e164a8e/raw/marketMetrics.json';
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

// What fraction of the insider's PRE-transaction stake this transaction
// represents — the size signal a raw share count or dollar value can't
// convey on its own (a 50,000-share sale means something very different
// for an insider who held 60,000 shares vs. one who held 6 million).
// sharesOwnedFollowingTransaction (the only post-transaction balance Form
// 4 discloses) plus the transaction's own share count is enough to derive
// the pre-transaction balance without needing any other filing: for a sale
// sharesBefore = sharesAfter + sharesTransacted (shares existed before,
// some were removed); for a purchase sharesBefore = sharesAfter -
// sharesTransacted (shares were added on top of whatever existed).
//
// otherHoldingsShares (new) accounts for shares of the SAME security held
// in OTHER ownership vehicles this specific transaction row doesn't touch
// -- see resolveOwnershipBuckets below. Without it, an insider whose stock
// is split across direct + indirect (trust, spouse, an LLC) ownership gets
// a wildly inflated percentage whenever a transaction only touches ONE of
// those vehicles. Verified live: META's Andrew Bosworth sold 7,848 shares
// leaving 828 direct -- computed as 90% of "stake" using only that direct
// balance, when his real total (828 direct + 69,170 via a living trust
// disclosed in the SAME filing) makes it ~10%. Also verified for CoreWeave's
// Michael Intrator: a Form 4 converting-then-fully-selling 107,692 shares
// through a side LLC ("Omnadora Capital") computed as a 100% "full exit"
// using only that LLC's own balance, when his real direct holdings
// (1,287,129 shares, untouched, same filing) make it under 0.3%.
//
// A purchase with zero pre-transaction shares ACROSS EVERY vehicle is a
// brand-new position (percent-of-prior-stake is undefined, not 0% or
// infinite) — flagged via isNewPosition rather than forced into a
// misleading percentage. Returns nulls (never NaN/Infinity) whenever
// sharesOwnedAfter is missing (a real, fairly common regex miss — see
// sharesOwnedAfter's own comment) or the derived pre-transaction balance
// is negative (a data anomaly, not a real stake) — the app's job is to
// render "no size context available" for these, not a garbage number.
function computeStakeSignificance(sharesTransacted, sharesOwnedAfter, acquiredDisposed, otherHoldingsShares = 0) {
  if (sharesOwnedAfter == null || !Number.isFinite(sharesOwnedAfter)) return { stakePercent: null, isNewPosition: false };
  const sharesBeforeInBucket = acquiredDisposed === 'A' ? sharesOwnedAfter - sharesTransacted : sharesOwnedAfter + sharesTransacted;
  if (sharesBeforeInBucket < 0) return { stakePercent: null, isNewPosition: false };
  const totalSharesBefore = sharesBeforeInBucket + Math.max(otherHoldingsShares, 0);
  if (totalSharesBefore === 0) return { stakePercent: null, isNewPosition: acquiredDisposed === 'A' };
  return { stakePercent: sharesTransacted / totalSharesBefore, isNewPosition: false };
}

// Form 4 Table I can report the SAME security across several distinct
// "ownership vehicles" in one filing -- direct, or indirect via a trust /
// spouse / LLC (each disclosed with its own directOrIndirectOwnership +
// natureOfOwnership and its OWN running sharesOwnedFollowingTransaction
// balance) -- via a mix of <nonDerivativeTransaction> rows (a vehicle that
// transacted today) and <nonDerivativeHolding> rows (a vehicle disclosed
// as unchanged). Bucketing by (securityTitle, directOrIndirect,
// natureOfOwnership) and keeping only the LAST balance seen per bucket
// (multiple same-day transaction rows for ONE vehicle are already a
// running total -- see MU's 27-row same-day example in
// stock-analyzer/src/components/InsiderActivity.js) gives each vehicle's
// true current balance without double-counting.
function ownershipBucketKey(securityTitle, directOrIndirect, natureOfOwnership) {
  return `${securityTitle || ''}|${directOrIndirect || ''}|${directOrIndirect === 'I' ? natureOfOwnership || '' : ''}`;
}

function extractBlockFields(block) {
  const securityTitle = block.match(/<securityTitle>\s*<value>([^<]+)<\/value>/i)?.[1]?.trim() || null;
  const directOrIndirect = block.match(/<directOrIndirectOwnership>\s*<value>([^<]+)<\/value>/i)?.[1]?.trim() || null;
  const natureOfOwnership = block.match(/<natureOfOwnership>\s*<value>([^<]*)<\/value>/i)?.[1]?.trim() || null;
  const sharesOwnedAfter = parseFloat(block.match(/<sharesOwnedFollowingTransaction>\s*<value>([^<]+)<\/value>/i)?.[1] || 'NaN');
  return { securityTitle, directOrIndirect, natureOfOwnership, sharesOwnedAfter: Number.isNaN(sharesOwnedAfter) ? null : sharesOwnedAfter };
}

// Returns { bucketFinalBalance: Map<bucketKey, number>, totalBySecurity: Map<securityTitle, number> }
// scanning every nonDerivativeTransaction + nonDerivativeHolding block in
// the filing, in document order (transaction rows for the same bucket
// naturally overwrite earlier ones as later, more-current balances).
function resolveOwnershipBuckets(transactionBlocks, holdingBlocks) {
  const bucketFinalBalance = new Map();
  const bucketSecurity = new Map();

  for (const block of transactionBlocks) {
    const { securityTitle, directOrIndirect, natureOfOwnership, sharesOwnedAfter } = extractBlockFields(block);
    if (sharesOwnedAfter == null) continue;
    const key = ownershipBucketKey(securityTitle, directOrIndirect, natureOfOwnership);
    bucketFinalBalance.set(key, sharesOwnedAfter);
    bucketSecurity.set(key, securityTitle);
  }
  // A holding row exists specifically to disclose a vehicle NOT touched by
  // any transaction today, so it should never override a transaction row's
  // balance for the same bucket -- only fill in buckets transactions didn't
  // already cover.
  for (const block of holdingBlocks) {
    const { securityTitle, directOrIndirect, natureOfOwnership, sharesOwnedAfter } = extractBlockFields(block);
    if (sharesOwnedAfter == null) continue;
    const key = ownershipBucketKey(securityTitle, directOrIndirect, natureOfOwnership);
    if (bucketFinalBalance.has(key)) continue;
    bucketFinalBalance.set(key, sharesOwnedAfter);
    bucketSecurity.set(key, securityTitle);
  }

  const totalBySecurity = new Map();
  for (const [key, balance] of bucketFinalBalance) {
    const sec = bucketSecurity.get(key);
    totalBySecurity.set(sec, (totalBySecurity.get(sec) || 0) + balance);
  }
  return { bucketFinalBalance, totalBySecurity };
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
  const holdingBlocks = xml.match(/<nonDerivativeHolding>[\s\S]*?<\/nonDerivativeHolding>/gi) || [];
  const { bucketFinalBalance, totalBySecurity } = resolveOwnershipBuckets(blocks, holdingBlocks);
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
    const ownedAfter = Number.isNaN(sharesOwnedAfter) ? null : sharesOwnedAfter;
    const { securityTitle, directOrIndirect, natureOfOwnership } = extractBlockFields(block);
    const bucketKey = ownershipBucketKey(securityTitle, directOrIndirect, natureOfOwnership);
    const thisBucketFinalBalance = bucketFinalBalance.get(bucketKey) ?? ownedAfter ?? 0;
    const otherHoldingsShares = (totalBySecurity.get(securityTitle) || 0) - thisBucketFinalBalance;
    const { stakePercent, isNewPosition } = computeStakeSignificance(shares, ownedAfter, acquiredDisposed, otherHoldingsShares);
    transactions.push({
      transactionDate,
      transactionCode,
      sharesTransacted: shares,
      pricePerShare: price,
      acquiredDisposed: acquiredDisposed || null,
      sharesOwnedAfter: ownedAfter,
      stakePercent,
      isNewPosition,
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
    filings.push({ accessionNumber: r.accessionNumber[i], filingDate: r.filingDate[i], primaryDocument: r.primaryDocument[i] });
  }
  return filings;
}

// The primary document's FILENAME (not its full path -- see below) varies
// per filer depending on whatever filing-agent software they use --
// verified live: AAPL uses "form4.xml", NVDA/AMZN use Workiva's
// "wk-form4_<id>.xml", GOOGL uses "ownership.xml". A hardcoded "form4.xml"
// 404s for every filer that isn't AAPL's exact convention, and that 404
// was being silently swallowed (fetchText returns null on 404, the caller
// just `continue`s) -- so a large fraction of the covered universe never
// even got a chance to surface real insider activity that existed.
//
// submissions.json's own `primaryDocument` field (e.g.
// "xslF345X06/wk-form4_1787607122.xml") gives the right FILENAME, but its
// directory prefix ("xslF345X06/") points at the human-readable XSLT-
// rendered HTML view, not the raw XML this file's regex parser needs --
// verified live both ways. The raw XML lives at the same accession folder
// using just the basename, with no subdirectory.
function form4XmlUrl(cik, accessionNumber, primaryDocument) {
  const accessionNoDashes = accessionNumber.replace(/-/g, '');
  const filename = primaryDocument ? primaryDocument.split('/').pop() : 'form4.xml';
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNoDashes}/${filename}`;
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
        const url = form4XmlUrl(cik, filing.accessionNumber, filing.primaryDocument);
        const xml = await fetchText(url);
        await sleep(SEC_SPACING_MS);
        if (!xml) {
          console.log(`  ${ticker}: 404/empty fetching ${url}`);
          continue;
        }
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

module.exports = { parseForm4, mergeTransactions, SIGNAL_CODES, computeStakeSignificance, form4XmlUrl };

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
