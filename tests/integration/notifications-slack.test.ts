import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertEvents } from "@/lib/db/schema";
import { postAlert, resolveAlert } from "@/lib/notifications/slack";
import "dotenv/config";

// Mock fetch — we never want test runs to actually POST to Slack.
function makeOkFetcher() {
  return vi.fn().mockResolvedValue(
    new Response("ok", { status: 200 }),
  ) as unknown as typeof fetch;
}

function makeFailFetcher(status = 500) {
  return vi.fn().mockResolvedValue(
    new Response("nope", { status }),
  ) as unknown as typeof fetch;
}

const ORIGINAL_ENV = { ...process.env };

describe("postAlert + resolveAlert (integration)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE alert_events CASCADE`);
    process.env.SLACK_WEBHOOK_ALERTS_URL = "https://hooks.slack.test/alerts";
    process.env.SLACK_WEBHOOK_DIGEST_URL = "https://hooks.slack.test/digest";
    process.env.SLACK_WEBHOOK_DEBUG_URL = "https://hooks.slack.test/debug";
    process.env.SLACK_MENTION_USER_IDS = "U0TEST123";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("posts a P1 alert and inserts an alert_events row", async () => {
    const fetcher = makeOkFetcher();
    const result = await postAlert(
      {
        severity: "p1",
        title: "shopify_intl ingest failed",
        dedupKey: "ingest.source.failed:shopify_intl",
        fields: { source: "shopify_intl", error: "HTTP 502" },
      },
      { fetcher },
    );
    expect(result.fired).toBe(true);

    const rows = await db.select().from(alertEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("p1");
    expect(rows[0].channel).toBe("alerts");
    expect(rows[0].dedupKey).toBe("ingest.source.failed:shopify_intl");
    expect(rows[0].resolvedAt).toBeNull();

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://hooks.slack.test/alerts");
    expect(init.method).toBe("POST");
  });

  it("suppresses a repeat fire while the prior alert is still open", async () => {
    const fetcher = makeOkFetcher();
    const first = await postAlert(
      { severity: "p1", title: "stale", dedupKey: "freshness:foo" },
      { fetcher },
    );
    const second = await postAlert(
      { severity: "p1", title: "stale", dedupKey: "freshness:foo" },
      { fetcher },
    );
    expect(first.fired).toBe(true);
    expect(second.fired).toBe(false);
    if (!second.fired) expect(second.reason).toBe("deduped");

    expect(fetcher).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(alertEvents);
    expect(rows).toHaveLength(1);
  });

  it("@mentions configured user IDs only on P0", async () => {
    const fetcher = makeOkFetcher();
    await postAlert({ severity: "p0", title: "outage", dedupKey: "k.p0" }, { fetcher });
    await postAlert({ severity: "p1", title: "warn", dedupKey: "k.p1" }, { fetcher });

    const calls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const p0Body = JSON.parse(calls[0][1].body as string);
    const p1Body = JSON.parse(calls[1][1].body as string);
    expect(p0Body.text).toContain("<@U0TEST123>");
    expect(p1Body.text).not.toContain("<@U0TEST123>");
  });

  it("returns no_webhook when the channel's URL is missing", async () => {
    delete process.env.SLACK_WEBHOOK_DIGEST_URL;
    const fetcher = makeOkFetcher();
    const result = await postAlert(
      { severity: "p2", title: "x", dedupKey: "k.no_webhook" },
      { fetcher },
    );
    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe("no_webhook");
    expect(fetcher).not.toHaveBeenCalled();
    const rows = await db.select().from(alertEvents);
    expect(rows).toHaveLength(0);
  });

  it("returns post_failed and skips the DB write when Slack returns non-2xx", async () => {
    const fetcher = makeFailFetcher(500);
    const result = await postAlert(
      { severity: "p1", title: "x", dedupKey: "k.post_failed" },
      { fetcher },
    );
    expect(result.fired).toBe(false);
    if (!result.fired) expect(result.reason).toBe("post_failed");

    // No DB row — otherwise dedup would suppress the next retry attempt.
    const rows = await db.select().from(alertEvents);
    expect(rows).toHaveLength(0);
  });

  it("resolveAlert marks open rows resolved and posts a follow-up", async () => {
    const fetcher = makeOkFetcher();
    await postAlert(
      { severity: "p1", title: "stale", dedupKey: "freshness:bar" },
      { fetcher },
    );
    const result = await resolveAlert("freshness:bar", { fetcher });
    expect(result.resolved).toBe(1);

    const rows = await db.select().from(alertEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).not.toBeNull();

    // One alert post + one resolve post = 2 fetch calls.
    expect(fetcher).toHaveBeenCalledTimes(2);
    const resolveBody = JSON.parse(
      (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string,
    );
    expect(resolveBody.text).toContain("Resolved");
  });

  it("resolveAlert is a no-op when no open alert exists", async () => {
    const fetcher = makeOkFetcher();
    const result = await resolveAlert("nonexistent:key", { fetcher });
    expect(result.resolved).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows the same key to fire again after resolve", async () => {
    const fetcher = makeOkFetcher();
    await postAlert({ severity: "p1", title: "x", dedupKey: "k.recur" }, { fetcher });
    await resolveAlert("k.recur", { fetcher });
    const second = await postAlert(
      { severity: "p1", title: "x again", dedupKey: "k.recur" },
      { fetcher },
    );
    expect(second.fired).toBe(true);

    const rows = await db.select().from(alertEvents);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.resolvedAt === null)).toHaveLength(1);
  });

  it("explicit channel override beats the severity default", async () => {
    const fetcher = makeOkFetcher();
    // P0 normally routes to alerts; force into digest.
    await postAlert(
      { severity: "p0", title: "x", dedupKey: "k.override", channel: "digest" },
      { fetcher },
    );
    const url = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toBe("https://hooks.slack.test/digest");
    const rows = await db.select().from(alertEvents);
    expect(rows[0].channel).toBe("digest");
  });
});
