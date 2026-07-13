import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sheetPollState } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  makeDriveGetModifiedTime,
  runSheetPoll,
  type PollState,
  type PollStateUpdate,
  type TriggerKind,
} from "@/lib/jobs/sheet-poll";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Near-real-time sheet sync (Todo #36). A lightweight poller — scheduled
// every ~5 min by Railway native cron (primary) + a GitHub Actions backstop —
// reads each sheet-fed source's Drive modifiedTime and, only when one actually
// changed, fires a targeted re-ingest:
//   full  -> POST /api/cron/ingest          (inventory/incoming/velocity/cost)
//   light -> POST /api/cron/refresh-ad-spend (ad-spend/fb-ads only)
// The downstream ingest is idempotent (truncate-replace), and a short
// per-source lock stops consecutive polls from stacking ingests.

async function readState(): Promise<Map<string, PollState>> {
  const rows = await db
    .select({
      source: sheetPollState.source,
      lastModifiedTime: sheetPollState.lastModifiedTime,
      lastTriggeredAt: sheetPollState.lastTriggeredAt,
    })
    .from(sheetPollState);
  return new Map(
    rows.map((r) => [
      r.source,
      { lastModifiedTime: r.lastModifiedTime, lastTriggeredAt: r.lastTriggeredAt },
    ]),
  );
}

async function writeState(updates: PollStateUpdate[]): Promise<void> {
  for (const u of updates) {
    await db
      .insert(sheetPollState)
      .values({
        source: u.source,
        sheetId: u.sheetId,
        lastModifiedTime: u.lastModifiedTime,
        lastCheckedAt: u.lastCheckedAt,
        lastTriggeredAt: u.lastTriggeredAt,
      })
      .onConflictDoUpdate({
        target: sheetPollState.source,
        set: {
          sheetId: u.sheetId,
          lastModifiedTime: u.lastModifiedTime,
          lastCheckedAt: u.lastCheckedAt,
          lastTriggeredAt: u.lastTriggeredAt,
        },
      });
  }
}

function makeTrigger(baseUrl: string, cronSecret: string): (kind: TriggerKind) => Promise<void> {
  const path = (kind: TriggerKind) =>
    kind === "full" ? "/api/cron/ingest" : "/api/cron/refresh-ad-spend";
  return async (kind: TriggerKind) => {
    // ?freshness=skip: poller triggers sync DATA at arbitrary hours; the
    // freshness/alerting sweep stays with the scheduled crons (first night
    // the poller ran overnight it fired 14 false P1s at 2am EST).
    const url = `${baseUrl}${path(kind)}?freshness=skip`;
    // Fire-and-forget: the ingest does its work before responding and can run
    // well past this poll's lifetime — we only need the request ACCEPTED.
    // The 8s abort exists to classify outcomes: a timeout means the server
    // took the request and is processing (aborting the fetch does not abort
    // the route handler); anything else is a real trigger failure.
    void fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(8000),
    }).catch((e) => {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        logger.info("poll_sheets.trigger.accepted", { kind });
        return;
      }
      logger.error("poll_sheets.trigger.failed", {
        kind,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  };
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Self-trigger over loopback: the ingest runs in THIS process, and the
  // Railway container cannot reliably reach its own public domain (observed
  // "fetch failed" 2026-07-10 through 07-12, which silently swallowed the
  // detected re-ingests while every OTHER container reached the same URL
  // fine). SKYBROOK_PUBLIC_URL stays as an override for non-standard deploys.
  const baseUrl = (
    process.env.SKYBROOK_PUBLIC_URL?.trim() ||
    `http://localhost:${process.env.PORT ?? 3000}`
  ).replace(/\/$/, "");

  let result;
  try {
    result = await runSheetPoll({
      getModifiedTime: makeDriveGetModifiedTime(),
      readState,
      writeState,
      trigger: makeTrigger(baseUrl, expected),
      now: () => new Date(),
    });
  } catch (e) {
    logger.error("poll_sheets.failed", { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  logger.info("poll_sheets.done", {
    checked: result.checked.length,
    changed: result.changed,
    decision: result.decision,
    fired: result.fired,
    lockedOut: result.lockedOut,
    errors: result.errors.length,
  });
  return NextResponse.json({ ok: true, ...result });
}

// Railway native cron invokes via GET.
export async function GET(req: Request) {
  return POST(req);
}
