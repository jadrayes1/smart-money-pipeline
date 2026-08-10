// scripts/lib/secEdgar.js
//
// Shared SEC EDGAR helpers used by both jobs in this repo — ported from
// the identical pattern in foreign-filings-pipeline/scripts/
// generateForeignFilingsCache.js (fetchJson w/ required User-Agent,
// ticker<->CIK map from SEC's own free company_tickers.json).

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
// SEC's fair-use policy asks for a descriptive User-Agent identifying the
// requester and a real contact — this is NOT an API key, just good-citizen
// identification; see https://www.sec.gov/os/webmaster-faq#developers
const SEC_USER_AGENT = 'stock-analyzer-app smart-money-pipeline contact:jadrayescpp@gmail.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A network interruption mid-request (verified live: a run stalled at 0%
// CPU for 5+ hours mid-run after an apparent connectivity blip, with no
// error and no progress — plain `fetch()` has no default timeout, so a
// connection that drops without a clean close/error just hangs forever)
// needs an explicit ceiling. 30s is generous for any single SEC/OpenFIGI
// request; a real timeout surfaces as a normal caught error instead of an
// indefinite hang.
const FETCH_TIMEOUT_MS = 30000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': SEC_USER_AGENT } });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

async function fetchTickerToCikMap() {
  const data = await fetchJson(SEC_TICKERS_URL);
  const map = new Map();
  for (const entry of Object.values(data || {})) {
    if (entry?.ticker && entry?.cik_str != null) {
      map.set(String(entry.ticker).toUpperCase(), String(entry.cik_str).padStart(10, '0'));
    }
  }
  return map;
}

// Reverse lookup (CIK -> ticker), same source, needed to resolve an
// issuer's own CIK (from a Form 4 or 13F info-table entry) back to a
// ticker without a second network round trip.
async function fetchCikToTickerMap() {
  const data = await fetchJson(SEC_TICKERS_URL);
  const map = new Map();
  for (const entry of Object.values(data || {})) {
    if (entry?.ticker && entry?.cik_str != null) {
      map.set(String(entry.cik_str).padStart(10, '0'), String(entry.ticker).toUpperCase());
    }
  }
  return map;
}

async function fetchSubmissions(cik) {
  return fetchJson(`${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`);
}

module.exports = {
  SEC_USER_AGENT,
  FETCH_TIMEOUT_MS,
  sleep,
  fetchWithTimeout,
  fetchJson,
  fetchText,
  fetchTickerToCikMap,
  fetchCikToTickerMap,
  fetchSubmissions,
};
