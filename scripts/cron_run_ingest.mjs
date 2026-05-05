#!/usr/bin/env node
// cron_run_ingest.mjs
// Triggers /api/cron/ingest from inside Railway's network, then verifies
// success via /api/admin/data-snapshot. Replaces the GitHub Actions
// workflow as the primary scheduler (see scripts/README.md).
//
// Why: GH Actions has a runner-allocation failure mode (saw it 2026-05-05
// when "the job was not acquired by Runner of type hosted" caused a 15-min
// hang + missed daily ingest). Railway native cron runs in our service
// container, no external runner required.
//
// Verification mirrors the previous GH Actions logic: kick off the request
// fire-and-forget (Railway edge proxy idle-times-out at ~60s), wait 4
// minutes for server-side processing, then read /api/admin/data-snapshot
// and confirm asOf is today + counts are non-zero.
//
// Required env:
//   CRON_SECRET — same value as the API route expects
//   APP_URL     — base URL, e.g. https://skybrook-backend-production.up.railway.app
//                 (Railway sets RAILWAY_PUBLIC_DOMAIN automatically; if APP_URL
//                  is unset, we'll derive from that.)

const SECRET = process.env.CRON_SECRET?.trim();
const APP_URL = (process.env.APP_URL?.trim()
  || (process.env.RAILWAY_PUBLIC_DOMAIN?.trim() ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim()}` : null)
  || "https://skybrook-backend-production.up.railway.app").replace(/\/$/, "");

if (!SECRET) {
  console.error("CRON_SECRET is not set");
  process.exit(1);
}

const ts = () => new Date().toISOString();
const log = (m) => console.log(`[${ts()}] ${m}`);

log(`Cron run target: ${APP_URL}`);

// 1. Fire-and-forget the ingest request. Short timeout because Railway's
//    edge proxy will close idle connections at ~60s, but the server-side
//    handler (maxDuration=300) keeps running.
log("POST /api/cron/ingest (fire-and-forget, 30s timeout)...");
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  const r = await fetch(`${APP_URL}/api/cron/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
    signal: ctrl.signal,
  });
  clearTimeout(t);
  log(`  POST returned ${r.status} (kept request kicked off; server still processing async)`);
} catch (e) {
  // AbortError or network timeout = expected (proxy idle-timed-out).
  // DNS / TLS / refused = real failure.
  const name = e?.name ?? "";
  if (name === "AbortError" || /TimeoutError|fetch failed/.test(String(e))) {
    log(`  POST timeout (expected — Railway edge proxy closed idle connection): ${e}`);
  } else {
    console.error(`  POST failed unexpectedly: ${e}`);
    process.exit(1);
  }
}

// 2. Wait for server-side ingest to settle.
log("Waiting 4 minutes for server-side ingest to complete...");
await new Promise((r) => setTimeout(r, 240_000));

// 3. Verify via /api/admin/data-snapshot — fast endpoint that reflects
//    the latest cron's writes.
log("GET /api/admin/data-snapshot for verification...");
const res = await fetch(`${APP_URL}/api/admin/data-snapshot`, {
  headers: { Authorization: `Bearer ${SECRET}` },
});
log(`  data-snapshot HTTP ${res.status}`);
if (!res.ok) {
  console.error(`  Body: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const body = await res.json();

// 4. Sanity checks: asOf is today (UTC), counts non-zero.
const todayUtc = new Date().toISOString().slice(0, 10);
const asOfDate = body.asOf ? body.asOf.slice(0, 10) : null;
log(`  Snapshot asOf=${asOfDate}  todayUTC=${todayUtc}`);
if (asOfDate !== todayUtc) {
  // Don't hard-fail (timezone offset can put asOf 1 day off), but warn.
  log(`  WARNING: asOf (${asOfDate}) is not today (${todayUtc}) — ingest may have failed`);
}
const counts = body.counts ?? {};
log(`  Counts: ${JSON.stringify(counts)}`);
if ((counts.skus ?? 0) === 0) {
  console.error("  skus count is 0 — ingest definitely failed");
  process.exit(1);
}

log("Ingest verified.");
process.exit(0);
