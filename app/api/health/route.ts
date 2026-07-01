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
import { alertEvents, dataPulls } from "@/lib/db/schema";
import { evaluateFreshness } from "@/lib/jobs/freshness-check";
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

  const [{ count: openAlerts = 0 } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(alertEvents)
    .where(isNull(alertEvents.resolvedAt));

  const tableFails = checks.filter((c) => c.status === "fail").length;
  const sourceFails = sources.filter((s) => s.lastStatus === "failed").length;
  const overall: "pass" | "fail" =
    tableFails === 0 && sourceFails === 0 ? "pass" : "fail";

  const body = {
    ok: overall === "pass",
    overall,
    asOfDate,
    threshold,
    openAlerts,
    sources,
    tables: [
      ...checks.map((c) => ({
        name: c.name,
        status: c.status as "pass" | "fail" | "warn",
        maxDate: c.maxDate as string | null,
        threshold: c.threshold as string | null,
        detail: c.detail,
        // Lineage: which dashboard pages render data derived from this
        // check's subject, so an operator reading /health knows the blast
        // radius without tracing the dependency by hand.
        affectedDashboards: affectedLabel(c.name),
      })),
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
    ],
  };

  // HTTP 503 on fail so healthchecks.io's "expected status" feature can
  // distinguish healthy from unhealthy without parsing the JSON body.
  return NextResponse.json(body, { status: overall === "pass" ? 200 : 503 });
}
