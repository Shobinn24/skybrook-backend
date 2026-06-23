import { describe, it, expect } from "vitest";
import { lineageForCheck, affectedLabel } from "@/lib/jobs/lineage";

describe("lineageForCheck", () => {
  it("maps a per-product ad_spend check to /performance", () => {
    const l = lineageForCheck("ad_spend_daily.product.men");
    expect(l.subject).toBe("ad_spend_daily");
    expect(l.dashboards).toEqual(["/performance"]);
  });

  it("does NOT let ad_spend_daily capture fb_ad_spend_daily (dot-boundary)", () => {
    const l = lineageForCheck("fb_ad_spend_daily");
    expect(l.subject).toBe("fb_ad_spend_daily");
    expect(l.dashboards).toEqual(["/fb-ads", "/bonus-tracker"]);
  });

  it("maps a channel-suffixed daily_sales check to the daily_sales pages", () => {
    const l = lineageForCheck("daily_sales.shopify_us");
    expect(l.subject).toBe("daily_sales");
    expect(l.dashboards).toContain("/performance");
    expect(l.dashboards).toContain("/factory-orders");
  });

  it("resolves a source-level volume check through source -> table -> pages", () => {
    // volume.sheets_fb_ads -> fb_ad_spend_daily -> /fb-ads, /bonus-tracker
    const l = lineageForCheck("volume.sheets_fb_ads");
    expect(l.subject).toBe("sheets_fb_ads");
    expect(l.dashboards).toEqual(["/fb-ads", "/bonus-tracker"]);
  });

  it("resolves a schema_drift source check the same way", () => {
    const l = lineageForCheck("schema_drift.sheets_inventory");
    expect(l.subject).toBe("sheets_inventory");
    expect(l.dashboards).toContain("/inventory");
    expect(l.dashboards).toContain("/stock-value");
  });

  it("treats both shopify channels as feeding daily_sales pages", () => {
    expect(lineageForCheck("volume.shopify_us").dashboards).toContain("/performance");
    expect(lineageForCheck("schema_drift.shopify_intl").dashboards).toContain("/performance");
  });

  it("routes active_skus_missing_cost to the dollar views (skus), not just factory-orders", () => {
    const l = lineageForCheck("factory_orders.active_skus_missing_cost");
    expect(l.subject).toBe("skus");
    expect(l.dashboards).toContain("/stock-value");
    expect(l.dashboards).toContain("/factory-orders");
  });

  it("routes approved_zero_lines to /factory-orders", () => {
    const l = lineageForCheck("factory_orders.approved_zero_lines");
    expect(l.subject).toBe("factory_orders");
    expect(l.dashboards).toEqual(["/factory-orders"]);
  });

  it("routes the product_line column-quality check to the skus dollar views", () => {
    const l = lineageForCheck("column_quality.skus_missing_product_line");
    expect(l.subject).toBe("skus");
    expect(l.dashboards).toContain("/stock-value");
  });

  it("routes the marketer-attribution check to /fb-ads + /bonus-tracker", () => {
    const l = lineageForCheck("column_quality.fb_marketer_attribution");
    expect(l.subject).toBe("fb_ad_spend_daily");
    expect(l.dashboards).toEqual(["/fb-ads", "/bonus-tracker"]);
  });

  it("flags reference tabs as non-dashboard (Scott's direct view)", () => {
    const l = lineageForCheck("reference_tab.fb_ads_tracker_2.2026");
    expect(l.dashboards).toEqual([]);
    expect(l.note).toMatch(/reference sheet tab/i);
  });

  it("returns an empty mapping for an unknown check name", () => {
    const l = lineageForCheck("something_unmapped");
    expect(l.dashboards).toEqual([]);
  });

  describe("affectedLabel", () => {
    it("joins dashboards into a readable string", () => {
      expect(affectedLabel("fb_ad_spend_daily")).toBe("/fb-ads, /bonus-tracker");
    });
    it("falls back to the note for reference tabs", () => {
      expect(affectedLabel("reference_tab.fb_ads_tracker_2.2026")).toMatch(
        /reference sheet tab/i,
      );
    });
    it("falls back to <none> for unknown subjects", () => {
      expect(affectedLabel("nope")).toBe("<none>");
    });
  });
});
