// tRPC procedure-level error tap. Wires every `INTERNAL_SERVER_ERROR`
// thrown by a procedure into the existing Slack alert pipeline so that
// the first user-triggered crash of a new feature (factory orders,
// shipping performance, overstock, anything) pages on-call.
//
// Why P1 + @mention: when Jasper or Scott hits a tRPC crash they're
// blocked from work; we want the dispatch instantly, not aggregated
// in the digest. The 2026-05-18 factory-order duplicate-key bug is
// the prototype — without this tap, the only evidence was the user
// noticing $0 totals.
//
// Dedup: keyed per-procedure (`trpc.error:<procedure>`). Repeat fires
// of the SAME procedure crashing while the alert is open are
// suppressed. `runFreshnessCheck` auto-resolves every open
// `trpc.error:*` alert at end of each cron tick, so genuine repeat
// crashes the next day re-page.
//
// Filter: only `INTERNAL_SERVER_ERROR` paths page. User-facing errors
// (BAD_REQUEST / UNAUTHORIZED / NOT_FOUND / FORBIDDEN / CONFLICT /
// PRECONDITION_FAILED / UNPROCESSABLE_CONTENT) are expected control
// flow and would generate noise.

import type { TRPCError } from "@trpc/server";
import { postAlert } from "@/lib/notifications/slack";
import { logger } from "@/lib/logger";

type TRPCErrorCode = TRPCError["code"];

// Codes that represent broken server-side state, not user-facing
// validation. Anything else is expected control flow.
const ALERT_ON_CODES: ReadonlySet<TRPCErrorCode> = new Set<TRPCErrorCode>([
  "INTERNAL_SERVER_ERROR",
]);

export type OnErrorPayload = {
  error: TRPCError;
  type: "query" | "mutation" | "subscription" | "unknown";
  path?: string;
  input?: unknown;
  req?: unknown;
};

export type AlertSink = (input: {
  severity: "p1" | "p2";
  title: string;
  dedupKey: string;
  fields: Record<string, string | number | null | undefined>;
}) => Promise<unknown>;

export async function reportTrpcError(
  payload: OnErrorPayload,
  sink: AlertSink = postAlert,
): Promise<{ posted: boolean; reason?: string }> {
  const code = payload.error.code as TRPCErrorCode;
  if (!ALERT_ON_CODES.has(code)) {
    return { posted: false, reason: `code_not_alertable:${code}` };
  }
  const path = payload.path ?? "<unknown>";
  const causeMessage =
    payload.error.cause instanceof Error
      ? payload.error.cause.message
      : payload.error.message;
  // 240 chars: long enough to identify the failure mode (Postgres
  // constraint name, drizzle column, etc.) without leaking large
  // payloads into Slack.
  const errorPreview = String(causeMessage ?? "").slice(0, 240);
  try {
    await sink({
      severity: "p1",
      title: `tRPC ${payload.type} ${path} threw ${code}`,
      dedupKey: `trpc.error:${path}`,
      fields: {
        procedure: path,
        type: payload.type,
        code,
        error: errorPreview,
      },
    });
    logger.warn("trpc.error.alerted", { path, code, type: payload.type });
    return { posted: true };
  } catch (e) {
    // Never let the alert path crash the request. postAlert already
    // catches its own fetch errors; this is defense-in-depth for
    // unexpected sink throws (e.g. DB connection blip on alert_events
    // dedup write).
    logger.warn("trpc.error.alert_failed", {
      path,
      code,
      error: e instanceof Error ? e.message : String(e),
    });
    return { posted: false, reason: "sink_threw" };
  }
}
