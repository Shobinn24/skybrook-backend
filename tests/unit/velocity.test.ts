import { describe, it, expect } from "vitest";
import { computeVelocity, type SaleEvent } from "@/lib/domain/velocity";

const mk = (date: string, qty: number, sku = "A", location: "US" | "CN" = "US"): SaleEvent =>
  ({ sku, quantity: qty, orderDateEst: date, routedLocation: location });

describe("computeVelocity", () => {
  it("returns 0 when there are no sales in window", () => {
    expect(computeVelocity({ events: [], asOfDate: "2026-04-22", windowDays: 7 })).toBe(0);
  });

  it("divides total units by window days", () => {
    const events = [mk("2026-04-20", 7), mk("2026-04-21", 7), mk("2026-04-22", 7)];
    // 21 units ÷ 7 days = 3.0 per day
    expect(computeVelocity({ events, asOfDate: "2026-04-22", windowDays: 7 })).toBe(3);
  });

  it("includes events on the as-of date and excludes those before window start", () => {
    const events = [mk("2026-04-15", 10), mk("2026-04-22", 5)];
    // 7-day window = 2026-04-16..2026-04-22, excludes 2026-04-15
    expect(computeVelocity({ events, asOfDate: "2026-04-22", windowDays: 7 })).toBeCloseTo(5 / 7, 5);
  });

  it("filters by sku when provided", () => {
    const events = [mk("2026-04-22", 5, "A"), mk("2026-04-22", 100, "B")];
    expect(computeVelocity({ events, asOfDate: "2026-04-22", windowDays: 3, sku: "A" })).toBeCloseTo(5 / 3, 5);
  });

  it("filters by routed location when provided", () => {
    const events = [mk("2026-04-22", 4, "A", "US"), mk("2026-04-22", 7, "A", "CN")];
    expect(computeVelocity({ events, asOfDate: "2026-04-22", windowDays: 1, sku: "A", routedLocation: "US" })).toBe(4);
  });
});
