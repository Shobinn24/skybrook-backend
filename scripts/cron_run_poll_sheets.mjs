#!/usr/bin/env node
// cron_run_poll_sheets.mjs
// Primary scheduler for near-real-time sheet sync (Todo #36), run by Railway
// native cron every ~5 min. Triggers /api/cron/poll-sheets, which reads each
// sheet-fed source's Drive modifiedTime and fires a targeted re-ingest only
// when a sheet actually changed (full ingest for inventory/incoming/velocity/
// cost; light refresh-ad-spend for ad-spend/fb-only changes).
//
// Why Railway-primary (not just GH Actions): GH scheduled runs fire 30min-2hr
// late (runner queue) and would defeat the "near-real-time" goal. Railway
// native cron runs in our container at the scheduled minute. GH Actions
// (.github/workflows/cron-poll-sheets.yml) stays as an idempotent backstop.
// Mirrors scripts/cron_run_refresh_ad_spend.mjs.
//
// The endpoint returns synchronously in a few seconds (6 cheap Drive metadata
// reads + fire-and-forget triggers), so we await the response directly.
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

log("POST /api/cron/poll-sheets (await response, 60s timeout)...");
let timedOut = false;
let res = null;
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);
  res = await fetch(`${APP_URL}/api/cron/poll-sheets`, {
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
    await fail(`  poll-sheets returned non-2xx (${res.status}): ${(await res.text()).slice(0, 400)}`);
  }
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON 2xx — accept */ }
  log(`  Response: ${JSON.stringify(body).slice(0, 500)}`);
  if (body && body.ok === false) {
    await fail(`  poll-sheets body reported ok:false`);
  }
  log("Sheet poll complete.");
  await hcPing("", JSON.stringify({
    changed: body?.changed,
    decision: body?.decision,
    fired: body?.fired,
  }));
  process.exit(0);
}

// Client timed out — the poll handler is short, so a timeout is unusual.
// Verify the server is alive.
log("Verifying via /api/health...");
const verify = await fetch(`${APP_URL}/api/health`, { headers: { Authorization: `Bearer ${SECRET}` } });
log(`  /api/health HTTP ${verify.status}`);
if (verify.status < 200 || verify.status >= 500) {
  await fail(`  /api/health returned ${verify.status} after poll`);
}
log("Sheet poll kicked off; server healthy.");
await hcPing("", "verified-via-health-after-timeout");
process.exit(0);
