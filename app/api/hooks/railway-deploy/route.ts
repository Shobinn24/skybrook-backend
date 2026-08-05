import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { parseDeployEvent } from "@/lib/jobs/deploy-status";
import { postAlert, resolveAlert } from "@/lib/notifications/slack";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// Railway deploy-status webhook receiver. Configured per Railway project
// (Settings -> Webhooks) with this URL including ?secret=. Railway does not
// sign webhook payloads, so the shared secret in the URL is the whole gate:
// wrong or missing secret returns 404 so the endpoint is not discoverable.
//
// FAILED/CRASHED deploys fire a p1 (Railway keeps the previous deployment
// running on a failed build, so without this the service silently stays on
// stale code — see lib/jobs/deploy-status.ts for the incident that proved
// it). A later SUCCESS for the same project+service resolves it.

function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const expected = process.env.RAILWAY_WEBHOOK_SECRET;
  const provided = new URL(req.url).searchParams.get("secret");
  if (!expected || !secretMatches(provided, expected)) {
    return new NextResponse(null, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const event = parseDeployEvent(body);
  if (event.kind === "ignored") {
    logger.info("railway_webhook.ignored", { status: event.status, reason: event.reason });
    return NextResponse.json({ ok: true, handled: "ignored", reason: event.reason });
  }

  logger.info("railway_webhook.event", {
    kind: event.kind,
    status: event.status,
    project: event.project,
    service: event.service,
  });

  if (event.kind === "failure") {
    const result = await postAlert({
      severity: "p1",
      dedupKey: event.dedupKey,
      title: event.title,
      fields: event.fields,
    });
    return NextResponse.json({ ok: true, handled: "failure", alert: result });
  }

  const result = await resolveAlert(event.dedupKey, {
    resolveMessage: event.title,
  });
  return NextResponse.json({ ok: true, handled: "success", resolved: result.resolved });
}
