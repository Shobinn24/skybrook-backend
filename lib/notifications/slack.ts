// Slack alert fanout — posts to one of three channels (alerts / digest /
// debug) via incoming webhooks, with dedup against open `alert_events`
// rows so the same problem doesn't re-page every cron tick.
//
// Webhook-based on purpose: no OAuth, no app install, no bot token in
// env. Trade-off: webhook responses don't return a message ts, so we
// can't `chat.update` to edit the original alert when it resolves. The
// "resolved" path posts a fresh message in the same channel instead of
// threading a reply. Phase-8 upgrade to a full Slack app would unlock
// threading and ack buttons (see project_skybrook_monitoring_options).
//
// Severity → channel default:
//   p0 / p1 → #skybrook-alerts (P0 also @mentions SLACK_MENTION_USER_IDS)
//   p2      → #skybrook-digest
//   p3      → #skybrook-debug
// Callers can override with `channel:` if a P2 needs to escalate, etc.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertEvents } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

export type AlertSeverity = "p0" | "p1" | "p2" | "p3";
export type AlertChannel = "alerts" | "digest" | "debug";

export type AlertInput = {
  severity: AlertSeverity;
  title: string;
  // Stable identifier for this incident class. While an alert with this
  // key is open (resolved_at IS NULL), repeat fires are suppressed.
  // Examples: "ingest.source.failed:shopify_intl",
  // "freshness:daily_sales:shopify_intl".
  dedupKey: string;
  fields?: Record<string, string | number | null | undefined>;
  // Optional override of the severity → channel default.
  channel?: AlertChannel;
};

export type PostAlertResult =
  | { fired: true; alertId: string }
  | { fired: false; reason: "deduped" | "no_webhook" | "post_failed" | "dev_suppressed" };

// Local dev runs with the PROD .env (real webhooks, often the prod DB), so
// without this guard a dev-session error pages the real alerts channel and
// writes alert_events rows into prod — happened 2026-07-13 when a dev
// server hit a not-yet-migrated table and fired an open P1. Alerting is
// suppressed whenever the process looks like dev (next dev, or the dev
// bypass the local server script sets); set SKYBROOK_ALERTS_FORCE=1 to
// deliberately exercise real alerts from dev. Tests run as NODE_ENV=test
// and are NOT suppressed — tests/setup.ts blanks the webhook URLs instead.
export function alertingSuppressed(): boolean {
  if (process.env.SKYBROOK_ALERTS_FORCE === "1") return false;
  return process.env.NODE_ENV === "development" || process.env.SKYBROOK_DEV_BYPASS === "1";
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  p0: "🔴",
  p1: "🟠",
  p2: "🟡",
  p3: "⚪️",
};

function channelForSeverity(s: AlertSeverity): AlertChannel {
  if (s === "p0" || s === "p1") return "alerts";
  if (s === "p2") return "digest";
  return "debug";
}

function webhookEnvForChannel(c: AlertChannel): string | undefined {
  if (c === "alerts") return process.env.SLACK_WEBHOOK_ALERTS_URL;
  if (c === "digest") return process.env.SLACK_WEBHOOK_DIGEST_URL;
  return process.env.SLACK_WEBHOOK_DEBUG_URL;
}

function mentionIdsForSeverity(s: AlertSeverity): string[] {
  if (s !== "p0") return [];
  const raw = process.env.SLACK_MENTION_USER_IDS ?? "";
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string } }
  | { type: "section"; fields?: Array<{ type: "mrkdwn"; text: string }>; text?: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "divider" };

type SlackPayload = {
  text: string;
  blocks: SlackBlock[];
};

function buildBlocks(
  input: AlertInput,
  mentions: string[],
  firedAt: Date,
): SlackPayload {
  const emoji = SEVERITY_EMOJI[input.severity];
  const headerLine = `${emoji} ${input.severity.toUpperCase()} — ${input.title}`;
  const mentionStr = mentions.map((id) => `<@${id}>`).join(" ");

  // Fallback text is what mobile push notifications + screen readers see.
  // Putting the @mention there ensures the user gets a personal push,
  // since the message is posted to a channel (no real DM).
  const fallback = mentionStr
    ? `${mentionStr} ${headerLine}`
    : headerLine;

  const fieldBlocks: Array<{ type: "mrkdwn"; text: string }> = [];
  if (input.fields) {
    for (const [key, value] of Object.entries(input.fields)) {
      if (value === null || value === undefined) continue;
      const safeValue = String(value).slice(0, 500);
      fieldBlocks.push({ type: "mrkdwn", text: `*${key}*\n\`\`\`${safeValue}\`\`\`` });
    }
  }

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: headerLine.slice(0, 150) } },
  ];

  if (mentionStr) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: mentionStr },
    });
  }

  if (fieldBlocks.length > 0) {
    // Slack limits a section to 10 fields. Chunk.
    for (let i = 0; i < fieldBlocks.length; i += 10) {
      blocks.push({ type: "section", fields: fieldBlocks.slice(i, i + 10) });
    }
  }

  const tsSec = Math.floor(firedAt.getTime() / 1000);
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `\`${input.dedupKey}\` · <!date^${tsSec}^{date_pretty} at {time}|${firedAt.toISOString()}>`,
      },
    ],
  });

  return { text: fallback, blocks };
}

async function postToWebhook(
  url: string,
  payload: SlackPayload,
  fetcher: typeof fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("slack.post.bad_response", { status: res.status, body: body.slice(0, 200) });
      return false;
    }
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("slack.post.error", { error: msg.slice(0, 200) });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function postAlert(
  input: AlertInput,
  opts?: { now?: () => Date; fetcher?: typeof fetch },
): Promise<PostAlertResult> {
  const now = opts?.now ?? (() => new Date());
  const fetcher = opts?.fetcher ?? fetch;

  if (alertingSuppressed()) {
    logger.info("slack.dev_suppressed", {
      severity: input.severity,
      dedupKey: input.dedupKey,
      title: input.title,
    });
    return { fired: false, reason: "dev_suppressed" };
  }

  const channel = input.channel ?? channelForSeverity(input.severity);
  const webhookUrl = webhookEnvForChannel(channel);
  if (!webhookUrl) {
    logger.warn("slack.no_webhook", { channel, dedupKey: input.dedupKey });
    return { fired: false, reason: "no_webhook" };
  }

  // Dedup: skip if an open alert with this key already exists.
  const open = await db
    .select({ id: alertEvents.id })
    .from(alertEvents)
    .where(and(eq(alertEvents.dedupKey, input.dedupKey), isNull(alertEvents.resolvedAt)))
    .limit(1);
  if (open.length > 0) {
    return { fired: false, reason: "deduped" };
  }

  const firedAt = now();
  const mentions = mentionIdsForSeverity(input.severity);
  const payload = buildBlocks(input, mentions, firedAt);

  const posted = await postToWebhook(webhookUrl, payload, fetcher);
  if (!posted) return { fired: false, reason: "post_failed" };

  const [row] = await db
    .insert(alertEvents)
    .values({
      dedupKey: input.dedupKey,
      severity: input.severity,
      title: input.title,
      payload: payload as object,
      channel,
      firedAt,
    })
    .returning({ id: alertEvents.id });

  return { fired: true, alertId: row.id };
}

// Plain informational post to the digest channel — no alert_events row, no
// dedup, so it can repeat daily (postAlert would suppress a repeat while
// "open"). Used by the morning ops digest.
export async function postDigestMessage(
  text: string,
  opts?: { fetcher?: typeof fetch },
): Promise<boolean> {
  if (alertingSuppressed()) {
    logger.info("slack.dev_suppressed", { action: "digest" });
    return false;
  }
  const url = process.env.SLACK_WEBHOOK_DIGEST_URL;
  if (!url) {
    logger.warn("slack.no_webhook", { channel: "digest", dedupKey: "ops_digest" });
    return false;
  }
  return postToWebhook(
    url,
    { text: text.slice(0, 150), blocks: [{ type: "section", text: { type: "mrkdwn", text } }] },
    opts?.fetcher ?? fetch,
  );
}

export async function resolveAlert(
  dedupKey: string,
  opts?: { now?: () => Date; fetcher?: typeof fetch; resolveMessage?: string },
): Promise<{ resolved: number }> {
  const now = opts?.now ?? (() => new Date());
  const fetcher = opts?.fetcher ?? fetch;
  const resolvedAt = now();

  if (alertingSuppressed()) {
    logger.info("slack.dev_suppressed", { dedupKey, action: "resolve" });
    return { resolved: 0 };
  }

  // Find any open alerts with this key (typically 0 or 1 — the unique
  // index enforces at-most-one open per key — but tolerate >1 defensively).
  const openRows = await db
    .select({ id: alertEvents.id, channel: alertEvents.channel, title: alertEvents.title })
    .from(alertEvents)
    .where(and(eq(alertEvents.dedupKey, dedupKey), isNull(alertEvents.resolvedAt)));

  if (openRows.length === 0) return { resolved: 0 };

  await db
    .update(alertEvents)
    .set({ resolvedAt })
    .where(and(eq(alertEvents.dedupKey, dedupKey), isNull(alertEvents.resolvedAt)));

  // Post resolve confirmation to each affected channel (deduped by Set
  // in case multiple rows somehow ended up in the same channel).
  const channels = new Set(openRows.map((r) => r.channel));
  const title = openRows[0].title;
  for (const channel of channels) {
    const url = webhookEnvForChannel(channel as AlertChannel);
    if (!url) continue;
    const tsSec = Math.floor(resolvedAt.getTime() / 1000);
    const text = opts?.resolveMessage ?? `Resolved: ${title}`;
    await postToWebhook(
      url,
      {
        text: `✅ ${text}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `✅ *${text}*` } },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `\`${dedupKey}\` resolved at <!date^${tsSec}^{date_pretty} at {time}|${resolvedAt.toISOString()}>`,
              },
            ],
          },
        ],
      },
      fetcher,
    );
  }

  return { resolved: openRows.length };
}

// Test-only re-exports for unit tests.
export const __internals__ = { buildBlocks, channelForSeverity };
