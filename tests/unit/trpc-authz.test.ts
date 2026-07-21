// Tier gating for the tRPC layer (lib/trpc/server.ts). Every procedure
// is built from a tier-scoped builder; these tests prove the FORBIDDEN /
// UNAUTHORIZED rejections fire BEFORE any resolver runs (no DB needed
// for the deny paths — the middleware throws first).

import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "@/lib/trpc/routers";
import type { TrpcContext } from "@/lib/trpc/context";
import { getAccessTier } from "@/lib/auth";

const caller = (ctx: Partial<TrpcContext>) =>
  appRouter.createCaller({
    email: "someone@example.com",
    tier: "ops",
    cashflowAllowed: false,
    ...ctx,
  });

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    throw new Error(`expected ${code}, but the call succeeded`);
  } catch (err) {
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe(code);
  }
}

describe("tRPC tier gating", () => {
  it("rejects sessions without an email as UNAUTHORIZED", async () => {
    await expectCode(
      caller({ email: null }).factoryOrder.monthKey({ date: "2026-06-10" }),
      "UNAUTHORIZED",
    );
  });

  it("ops procedures reject marketing and fb_ads_only tiers", async () => {
    // monthKey is a pure ops procedure — no DB touched on success either.
    await expect(
      caller({ tier: "ops" }).factoryOrder.monthKey({ date: "2026-06-10" }),
    ).resolves.toBeTruthy();
    await expectCode(
      caller({ tier: "marketing" }).factoryOrder.monthKey({ date: "2026-06-10" }),
      "FORBIDDEN",
    );
    await expectCode(
      caller({ tier: "fb_ads_only" }).factoryOrder.monthKey({ date: "2026-06-10" }),
      "FORBIDDEN",
    );
  });

  it("fb_ads_only cannot reach marketing or ops surfaces", async () => {
    const c = caller({ tier: "fb_ads_only" });
    await expectCode(c.inventory.getInventoryRows({ location: "US" }), "FORBIDDEN");
    await expectCode(c.inventory.bulkApprovePending(), "FORBIDDEN");
    await expectCode(c.factoryOrder.list(), "FORBIDDEN");
    await expectCode(c.admin.listKnownFamilies(), "FORBIDDEN");
    await expectCode(c.shippingAudit.getView(), "FORBIDDEN");
    await expectCode(c.pipeline.getPullHistoryAllSources(), "FORBIDDEN");
  });

  it("fb_ads_only can read launches but NOT add/update/remove them (client 2026-07-07)", async () => {
    const c = caller({ tier: "fb_ads_only" });
    // Deny paths throw in the tier middleware BEFORE any resolver runs, so
    // no DB is needed. (The allow path for getLaunches hits the DB and is
    // covered in tests/integration/launches-auto.test.ts.)
    await expectCode(
      c.inventory.addLaunch({ productName: "X", shipmentName: "Y" }),
      "FORBIDDEN",
    );
    await expectCode(
      c.inventory.updateLaunchDates({
        id: "00000000-0000-0000-0000-000000000000",
        sellingPriceUsd: "24.99",
      }),
      "FORBIDDEN",
    );
    await expectCode(
      c.inventory.removeLaunch({ id: "00000000-0000-0000-0000-000000000000" }),
      "FORBIDDEN",
    );
    // getLaunchFormOptions feeds the add form — marketing-tier as well.
    await expectCode(c.inventory.getLaunchFormOptions(), "FORBIDDEN");
  });

  it("fb_ads_only can read the bonus tracker but NOT touch approval/notification surfaces (client 2026-07-02)", async () => {
    const c = caller({ tier: "fb_ads_only" });
    // Deny paths throw in the tier middleware BEFORE any resolver runs,
    // so no DB is needed. (The allow path for getBonusTracker & co. hits
    // the DB and is covered in tests/integration/bonus-tracker.test.ts.)
    await expectCode(
      c.inventory.approveBonus({
        awardId: "00000000-0000-0000-0000-000000000000",
        approval: "approved_full",
      }),
      "FORBIDDEN",
    );
    await expectCode(
      c.inventory.rejectBonus({
        awardId: "00000000-0000-0000-0000-000000000000",
      }),
      "FORBIDDEN",
    );
    await expectCode(c.inventory.getPendingBonusApprovals(), "FORBIDDEN");
    await expectCode(c.inventory.previewBonusNotification(), "FORBIDDEN");
    await expectCode(c.inventory.sendBonusNotification(), "FORBIDDEN");
  });

  it("getMyAccessTier reflects the session tier for every tier", async () => {
    await expect(
      caller({ tier: "fb_ads_only" }).inventory.getMyAccessTier(),
    ).resolves.toEqual({ tier: "fb_ads_only" });
    await expect(
      caller({ tier: "marketing" }).inventory.getMyAccessTier(),
    ).resolves.toEqual({ tier: "marketing" });
    await expect(
      caller({ tier: "ops" }).inventory.getMyAccessTier(),
    ).resolves.toEqual({ tier: "ops" });
    await expect(
      caller({ tier: "reviews_only" }).inventory.getMyAccessTier(),
    ).resolves.toEqual({ tier: "reviews_only" });
  });

  it("reviews_only cannot reach ops/marketing/fb-ads surfaces (client 2026-07-17)", async () => {
    const c = caller({ tier: "reviews_only" });
    await expectCode(c.factoryOrder.monthKey({ date: "2026-06-10" }), "FORBIDDEN");
    await expectCode(c.inventory.getInventoryRows({ location: "US" }), "FORBIDDEN");
    await expectCode(c.inventory.getLaunches(), "FORBIDDEN");
    await expectCode(c.inventory.getBonusTracker(), "FORBIDDEN");
    await expectCode(c.pipeline.getPullHistoryAllSources(), "FORBIDDEN");
    await expectCode(c.cashflow.getAssumptions(), "FORBIDDEN");
  });

  it("reviews_only cannot invoke reviews mutations or internal QA queries", async () => {
    const c = caller({ tier: "reviews_only" });
    await expectCode(c.reviews.refresh(), "FORBIDDEN");
    await expectCode(c.reviews.unparsed(), "FORBIDDEN");
  });

  it("marketing and fb_ads_only cannot reach the reviews/sizing surface", async () => {
    // The reviews surface opened to reviews_only, NOT to the other
    // restricted tiers — deny paths throw before any resolver runs.
    await expectCode(caller({ tier: "marketing" }).sizing.directionMix({}), "FORBIDDEN");
    await expectCode(caller({ tier: "fb_ads_only" }).sizing.productRates(), "FORBIDDEN");
    await expectCode(caller({ tier: "marketing" }).reviews.overview({}), "FORBIDDEN");
  });

  it("marketing cannot reach ops-only surfaces", async () => {
    const c = caller({ tier: "marketing" });
    await expectCode(c.inventory.getInventoryRows({ location: "US" }), "FORBIDDEN");
    await expectCode(c.inventory.markIncomingReceived({
      shipmentName: "x", destination: "US", expectedArrival: "2026-06-10",
    }), "FORBIDDEN");
    await expectCode(c.factoryOrder.approve({ orderId: "00000000-0000-0000-0000-000000000000" }), "FORBIDDEN");
    await expectCode(c.admin.deleteOverride({ family: "x" }), "FORBIDDEN");
  });

  it("viewer can read every tier's query surface (client 2026-07-21)", async () => {
    // monthKey is the pure ops query (no DB on success) — a viewer
    // session passes the ops-only builder because requireTier admits
    // viewer for queries. Success paths that hit the DB are exercised
    // by the integration suites with real ops sessions; the point here
    // is the middleware admits viewer instead of throwing FORBIDDEN.
    await expect(
      caller({ tier: "viewer" }).factoryOrder.monthKey({ date: "2026-06-10" }),
    ).resolves.toBeTruthy();
    await expect(
      caller({ tier: "viewer" }).inventory.getMyAccessTier(),
    ).resolves.toEqual({ tier: "viewer" });
  });

  it("viewer cannot invoke ANY mutation on any surface (client 2026-07-21)", async () => {
    const c = caller({ tier: "viewer" });
    await expectCode(
      c.inventory.addLaunch({ productName: "X", shipmentName: "Y" }),
      "FORBIDDEN",
    );
    await expectCode(
      c.inventory.approveBonus({
        awardId: "00000000-0000-0000-0000-000000000000",
        approval: "approved_full",
      }),
      "FORBIDDEN",
    );
    await expectCode(c.inventory.bulkApprovePending(), "FORBIDDEN");
    await expectCode(
      c.factoryOrder.approve({ orderId: "00000000-0000-0000-0000-000000000000" }),
      "FORBIDDEN",
    );
    await expectCode(c.admin.deleteOverride({ family: "x" }), "FORBIDDEN");
    await expectCode(c.reviews.refresh(), "FORBIDDEN");
    await expectCode(
      c.inventory.markIncomingReceived({
        shipmentName: "x", destination: "US", expectedArrival: "2026-06-10",
      }),
      "FORBIDDEN",
    );
  });

  it("viewer cannot read cashflow without the cashflow allowlist", async () => {
    await expectCode(
      caller({ tier: "viewer", cashflowAllowed: false }).cashflow.getAssumptions(),
      "FORBIDDEN",
    );
  });

  it("cashflow procedures are gated by the allowlist flag, not tier", async () => {
    // Even a full-ops session is denied without the cashflow allowlist.
    await expectCode(
      caller({ tier: "ops", cashflowAllowed: false }).cashflow.getAssumptions(),
      "FORBIDDEN",
    );
    await expectCode(
      caller({ tier: "marketing", cashflowAllowed: false }).cashflow.deleteManualEntry({ ref: "x" }),
      "FORBIDDEN",
    );
  });
});

describe("getAccessTier", () => {
  it("fb_ads_only wins over marketing when an email is in both lists", () => {
    process.env.SKYBROOK_FB_ADS_ONLY_EMAILS = "buyer@example.com";
    process.env.SKYBROOK_MARKETING_EMAILS = "buyer@example.com,marketer@example.com";
    try {
      expect(getAccessTier("buyer@example.com")).toBe("fb_ads_only");
      expect(getAccessTier("marketer@example.com")).toBe("marketing");
      expect(getAccessTier("owner@example.com")).toBe("ops");
    } finally {
      delete process.env.SKYBROOK_FB_ADS_ONLY_EMAILS;
      delete process.env.SKYBROOK_MARKETING_EMAILS;
    }
  });

  it("viewer resolves from its list; restricted tiers win when in both", () => {
    process.env.SKYBROOK_VIEWER_EMAILS = "luke@anacondafightwear.co,both-v@example.com";
    process.env.SKYBROOK_FB_ADS_ONLY_EMAILS = "both-v@example.com";
    try {
      expect(getAccessTier("luke@anacondafightwear.co")).toBe("viewer");
      // fb_ads_only stays the tightest tier when an email is in both
      expect(getAccessTier("both-v@example.com")).toBe("fb_ads_only");
    } finally {
      delete process.env.SKYBROOK_VIEWER_EMAILS;
      delete process.env.SKYBROOK_FB_ADS_ONLY_EMAILS;
    }
  });

  it("reviews_only resolves from its list; fb_ads_only wins when in both", () => {
    process.env.SKYBROOK_REVIEWS_ONLY_EMAILS = "kris@kndrsn.com,both@example.com";
    process.env.SKYBROOK_FB_ADS_ONLY_EMAILS = "both@example.com";
    process.env.SKYBROOK_MARKETING_EMAILS = "kris@kndrsn.com";
    try {
      // reviews_only wins over a marketing listing for the same email
      expect(getAccessTier("kris@kndrsn.com")).toBe("reviews_only");
      // fb_ads_only stays the tightest tier when an email is in both
      expect(getAccessTier("both@example.com")).toBe("fb_ads_only");
    } finally {
      delete process.env.SKYBROOK_REVIEWS_ONLY_EMAILS;
      delete process.env.SKYBROOK_FB_ADS_ONLY_EMAILS;
      delete process.env.SKYBROOK_MARKETING_EMAILS;
    }
  });
});
