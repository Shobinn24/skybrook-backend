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
    await expectCode(c.inventory.getBonusTracker(), "FORBIDDEN");
    await expectCode(c.inventory.getLaunches(), "FORBIDDEN");
    await expectCode(c.inventory.getInventoryRows({ location: "US" }), "FORBIDDEN");
    await expectCode(c.inventory.bulkApprovePending(), "FORBIDDEN");
    await expectCode(c.factoryOrder.list(), "FORBIDDEN");
    await expectCode(c.admin.listKnownFamilies(), "FORBIDDEN");
    await expectCode(c.shippingAudit.getView(), "FORBIDDEN");
    await expectCode(c.pipeline.getPullHistoryAllSources(), "FORBIDDEN");
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
});
