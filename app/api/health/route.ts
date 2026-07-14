// Read-only health endpoint. Pinged externally by healthchecks.io and
// queryable by humans / operators. NO auth — must be reachable by
// external pingers without a session cookie or bearer token. Surfaces
// non-sensitive ops state only: per-source last-pull status (status
// + finished-at timestamps, but NOT error bodies which may include
// upstream payload fragments), table freshness checks, and an
// open-alert count. HTTP 503 when anything is failing so HC flips red.
//
// Side-effect free. Does NOT fire Slack alerts (the cron is the
// authority for that — alerting from a per-minute health pinger would
// race against the cron's own postAlert/resolveAlert flow). It only
// READS alert_events to surface the count of currently-open alerts.

import { NextResponse } from "next/server";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertEvents, dataPulls, supermetricsQueryState } from "@/lib/db/schema";
import { evaluateFreshness } from "@/lib/jobs/freshness-check";
import { checkAuthRoundTrip } from "@/lib/jobs/auth-roundtrip-check";
import { ackFor, loadAcks } from "@/lib/jobs/health-acks";
import { affectedLabel } from "@/lib/jobs/lineage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCES = [
  "sheets_inventory",
  "sheets_incoming",
  "sheets_ad_spend",
  "sheets_fb_ads",
  "sheets_applovin",
  "sheets_fb_geo",
  "sheets_fb_url_map",
  "sheets_fb_product_map",
  "sheets_launch_info",
  "shopify_us",
  "shopify_intl",
] as const;

type SourceHealth = {
  source: string;
  lastStatus: "success" | "failed" | "partial" | "no_data";
  lastFinishedAt: string | null;
  // Truncated; we never expose full error bodies (they sometimes
  // contain upstream JSON fragments that could leak SKU lists, IDs,
  // etc.). The full error is logged + searchable in data_pulls.
  lastErrorPreview: string | null;
};

async function getSourceHealth(): Promise<SourceHealth[]> {
  const out: SourceHealth[] = [];
  for (const source of SOURCES) {
    const [row] = await db
      .select({
        status: dataPulls.status,
        finishedAt: dataPulls.finishedAt,
        errorMessage: dataPulls.errorMessage,
      })
      .from(dataPulls)
      .where(eq(dataPulls.source, source))
      .orderBy(desc(dataPulls.startedAt))
      .limit(1);

    if (!row) {
      out.push({
        source,
        lastStatus: "no_data",
        lastFinishedAt: null,
        lastErrorPreview: null,
      });
      continue;
    }

    out.push({
      source,
      lastStatus: row.status,
      lastFinishedAt: row.finishedAt?.toISOString() ?? null,
      lastErrorPreview: row.errorMessage ? row.errorMessage.slice(0, 120) : null,
    });
  }
  return out;
}

// Probes the cloud whatsmeow bridge that delivers bonus notifications.
// Uses "warn" (never "fail") so a dropped WhatsApp session shows up in the
// morning daily check WITHOUT flipping /health to 503 — the bridge being
// down does not break the dashboards. "not configured" is expected until
// the bridge env vars are set.
async function checkWhatsAppBridge(): Promise<{
  name: string;
  status: "pass" | "warn";
  detail: string;
}> {
  const url = process.env.WHATSAPP_BRIDGE_URL;
  if (!url) return { name: "whatsapp_bridge", status: "warn", detail: "not configured" };
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    const b = (await res.json()) as { loggedIn?: boolean; connected?: boolean };
    const ok = !!b.loggedIn && !!b.connected;
    return {
      name: "whatsapp_bridge",
      status: ok ? "pass" : "warn",
      detail: `loggedIn=${b.loggedIn} connected=${b.connected}`,
    };
  } catch (e) {
    return {
      name: "whatsapp_bridge",
      status: "warn",
      detail: `unreachable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120),
    };
  }
}

export async function GET() {
  const sources = await getSourceHealth();
  const { asOfDate, threshold, checks } = await evaluateFreshness();
  const bridge = await checkWhatsAppBridge();
  const auth = await checkAuthRoundTrip();
  const acks = await loadAcks();
  const now = new Date();

  const [{ count: openAlerts = 0 } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(alertEvents)
    .where(isNull(alertEvents.resolvedAt));

  // Upstream refresh visibility: last-seen state of every backend-feeding
  // Supermetrics query, persisted by the cron sweep. Answers "is stale data
  // OUR ingest, THEIR refresh, or just platform-side settlement lag?"
  // without waiting for the 48h staleness alert.
  const smRows = await db.select().from(supermetricsQueryState);
  const supermetricsQueries = smRows
    .map((r) => ({
      label: r.label,
      tabName: r.tabName,
      lastRefreshedAt: r.lastRefreshedAt?.toISOString() ?? null,
      ageHours: r.lastRefreshedAt
        ? Math.round(((now.getTime() - r.lastRefreshedAt.getTime()) / 3_600_000) * 10) / 10
        : null,
      status: r.status,
      checkedAt: r.checkedAt.toISOString(),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Acknowledged failures stay visible (status stays "fail", flagged
  // acknowledged) but stop flipping `overall` — red means NEW problems.
  const checkAck = (name: string) => ackFor(name, acks, now);
  const tableFails = checks.filter(
    (c) => c.status === "fail" && !checkAck(c.name),
  ).length;
  const sourceFails = sources.filter(
    (s) => s.lastStatus === "failed" && !checkAck(`source:${s.source}`),
  ).length;
  // auth_round_trip "fail" is page-worthy (login gate broken = every page
  // unusable or unprotected — the 2026-07-01 outage class), so it flips
  // overall like a data-freshness fail. Its "warn" (probe couldn't run)
  // does not. Deliberately NOT ackable — there is no acceptable "known
  // broken" state for the login gate.
  const authFails = auth.status === "fail" ? 1 : 0;
  const overall: "pass" | "fail" =
    tableFails === 0 && sourceFails === 0 && authFails === 0 ? "pass" : "fail";

  const body = {
    ok: overall === "pass",
    overall,
    asOfDate,
    threshold,
    openAlerts,
    supermetricsQueries,
    acknowledged: acks
      .filter((a) => !a.expiresAt || a.expiresAt.getTime() > now.getTime())
      .map((a) => ({
        pattern: a.pattern,
        reason: a.reason,
        expiresAt: a.expiresAt?.toISOString() ?? null,
      })),
    sources: sources.map((s) => {
      const ack = s.lastStatus === "failed" ? checkAck(`source:${s.source}`) : null;
      return ack ? { ...s, acknowledged: true, ackReason: ack.reason } : s;
    }),
    tables: [
      ...checks.map((c) => {
        const ack = c.status === "fail" ? checkAck(c.name) : null;
        return {
          name: c.name,
          status: c.status as "pass" | "fail" | "warn",
          maxDate: c.maxDate as string | null,
          threshold: c.threshold as string | null,
          detail: c.detail,
          ...(ack ? { acknowledged: true, ackReason: ack.reason } : {}),
          // Lineage: which dashboard pages render data derived from this
          // check's subject, so an operator reading /health knows the blast
          // radius without tracing the dependency by hand.
          affectedDashboards: affectedLabel(c.name),
        };
      }),
      // Bonus-notification delivery bridge. "warn" status never affects
      // `overall` (only "fail" does), so a dropped session is visible in
      // the daily check but does not 503 the endpoint.
      {
        name: bridge.name,
        status: bridge.status,
        maxDate: null,
        threshold: null,
        detail: bridge.detail,
        affectedDashboards: affectedLabel(bridge.name),
      },
      // Auth round-trip: signs a session token (Node runtime) and fetches
      // the protected selfcheck route through the real middleware (Edge
      // sandbox), catching sign/verify divergence before users hit it.
      {
        name: auth.name,
        status: auth.status,
        maxDate: null,
        threshold: null,
        detail: auth.detail,
        affectedDashboards: affectedLabel(auth.name),
      },
    ],
  };

  // HTTP 503 on fail so healthchecks.io's "expected status" feature can
  // distinguish healthy from unhealthy without parsing the JSON body.
  return NextResponse.json(body, { status: overall === "pass" ? 200 : 503 });
}
