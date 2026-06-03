#!/usr/bin/env node
// cron_run_refresh_ad_spend.mjs
// Primary scheduler for the afternoon ad-spend refresh, run by Railway
// native cron. Triggers /api/cron/refresh-ad-spend (re-pulls sheets_ad_spend
// + sheets_fb_ads, runs the FB-Tracker-2 daily append + bonus crossings +
// freshness for those two).
//
// Why Railway-primary (not just GH Actions): the GH scheduled run fires
// 30min-2hr late (runner queue), which delays the FB-Tracker-2 2026-tab
// append to ~1:30-2pm ET. Railway native cron runs in our container at the
// scheduled minute. GH Actions (.github/workflows/cron-refresh-ad-spend.yml)
// stays as an idempotent backstop. Mirrors the main-ingest cron pattern
// (scripts/cron_run_ingest.mjs).
//
// Unlike the ingest endpoint, /api/cron/refresh-ad-spend returns
// synchronously in ~10s (no Shopify backfill / phase2 / auto-receipt), so we
// await the response directly. We still tolerate a Railway edge-proxy idle
// timeout (~60s) the same way the GH workflow does: on a client timeout,
// the server keeps running, so we verify via /api/health.
//
// Required env:
//   CRON_SECRET — same value the API route expects
//   APP_URL     — base URL (falls back to RAILWAY_PUBLIC_DOMAIN, then the
//                 canonical production URL)
// Optional env:
//   HEALTHCHECKS_URL — healthchecks.io ping URL; /start on start, base on
//                      success, /fail on failure. Skipped silently if unset.

const SECRET = process.env.CRON_SECRET?.trim();
const APP_URL = (process.env.APP_URL?.trim()
  || (process.env.RAILWAY_PUBLIC_DOMAIN?.trim() ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim()}` : null)
  || "https://skybrook-backend-production.up.railway.app").replace(/\/$/, "");
const HC_URL = process.env.HEALTHCHECKS_URL?.trim()?.replace(/\/$/, "");

if (!SECRET) {
  console.error("CRON_SECRET is not set");
  process.exit(1);
}

const ts = () => new Date().toISOString();
const log = (m) => console.log(`[${ts()}] ${m}`);

// Best-effort healthchecks.io ping. Never throws.
async function hcPing(suffix = "", body = "") {
  if (!HC_URL) return;
  const url = suffix ? `${HC_URL}/${suffix}` : HC_URL;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    await fetch(url, { method: body ? "POST" : "GET", body: body || undefined, signal: ctrl.signal });
    clearTimeout(t);
    log(`  hc-ping ${suffix || "ok"} → ${url}`);
  } catch (e) {
    log(`  hc-ping ${suffix || "ok"} failed: ${e}`);
  }
}

async function fail(msg) {
  console.error(msg);
  await hcPing("fail", msg);
  process.exit(1);
}

log(`Cron run target: ${APP_URL}`);
log(`Healthchecks.io: ${HC_URL ? "enabled" : "disabled (HEALTHCHECKS_URL unset)"}`);

await hcPing("start");

// POST the refresh. The endpoint completes in ~10s and returns its summary
// synchronously; 90s is ample headroom. On a proxy idle timeout the handler
// keeps running, so we fall back to a /api/health probe.
log("POST /api/cron/refresh-ad-spend (await response, 90s timeout)...");
let timedOut = false;
let res = null;
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90_000);
  res = await fetch(`${APP_URL}/api/cron/refresh-ad-spend`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
    signal: ctrl.signal,
  });
  clearTimeout(t);
} catch (e) {
  const name = e?.name ?? "";
  if (name === "AbortError" || /TimeoutError|fetch failed/.test(String(e))) {
    timedOut = true;
    log(`  POST timed out client-side (server still running): ${e}`);
  } else {
    await fail(`  POST failed unexpectedly: ${e}`);
  }
}

if (!timedOut) {
  log(`  POST returned ${res.status}`);
  if (!res.ok) {
    await fail(`  refresh returned non-2xx (${res.status}): ${(await res.text()).slice(0, 400)}`);
  }
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON 2xx — accept */ }
  log(`  Response: ${JSON.stringify(body).slice(0, 500)}`);
  if (body && body.ok === false) {
    await fail(`  refresh body reported ok:false`);
  }
  log("Ad-spend refresh verified.");
  await hcPing("", JSON.stringify({
    appended: body?.tracker2Append?.appendedDates,
    freshness: body?.freshness,
  }));
  process.exit(0);
}

// Client timed out — verify the server is alive (handler keeps running).
log("Waiting 90s, then verifying via /api/health...");
await new Promise((r) => setTimeout(r, 90_000));
const verify = await fetch(`${APP_URL}/api/health`, { headers: { Authorization: `Bearer ${SECRET}` } });
log(`  /api/health HTTP ${verify.status}`);
if (verify.status < 200 || verify.status >= 500) {
  await fail(`  /api/health returned ${verify.status} after refresh`);
}
log("Ad-spend refresh kicked off; server healthy.");
await hcPing("", "verified-via-health-after-timeout");
process.exit(0);
