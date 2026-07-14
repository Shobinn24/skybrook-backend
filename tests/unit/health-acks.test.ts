import { describe, expect, it } from "vitest";
import { ackFor, type AckRow } from "@/lib/jobs/health-acks";

const NOW = new Date("2026-07-14T12:00:00Z");
const ack = (pattern: string, expiresAt: Date | null = null): AckRow => ({
  pattern,
  reason: "test",
  expiresAt,
});

describe("ackFor", () => {
  it("matches exact names and prefix patterns", () => {
    const acks = [ack("factory_orders.active_skus_missing_cost"), ack("fb_url_unmapped.*")];
    expect(ackFor("factory_orders.active_skus_missing_cost", acks, NOW)).not.toBeNull();
    expect(ackFor("fb_url_unmapped.shop_everdries_com_cotton", acks, NOW)).not.toBeNull();
    expect(ackFor("fb_url_unmapped.anything_else", acks, NOW)).not.toBeNull();
    expect(ackFor("daily_sales.cross_channel_skew", acks, NOW)).toBeNull();
    // exact pattern must not behave as a prefix
    expect(ackFor("factory_orders.active_skus_missing_cost.extra", acks, NOW)).toBeNull();
  });

  it("expired acks stop matching; future expiries still match", () => {
    const expired = [ack("x", new Date("2026-07-14T11:59:59Z"))];
    const live = [ack("x", new Date("2026-07-15T00:00:00Z"))];
    expect(ackFor("x", expired, NOW)).toBeNull();
    expect(ackFor("x", live, NOW)).not.toBeNull();
  });

  it("sources ack under the source: prefix convention", () => {
    const acks = [ack("source:sheets_ad_spend")];
    expect(ackFor("source:sheets_ad_spend", acks, NOW)).not.toBeNull();
    expect(ackFor("source:shopify_us", acks, NOW)).toBeNull();
  });
});
