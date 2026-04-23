import { describe, it, expect } from "vitest";
import { computeDaysOfStock } from "@/lib/domain/days-of-stock";

describe("computeDaysOfStock", () => {
  it("divides on-hand by daily velocity", () => {
    expect(computeDaysOfStock({ onHand: 100, velocityPerDay: 5 })).toBe(20);
  });

  it("returns Infinity when velocity is zero and stock is positive", () => {
    expect(computeDaysOfStock({ onHand: 100, velocityPerDay: 0 })).toBe(Infinity);
  });

  it("returns 0 when stock is zero", () => {
    expect(computeDaysOfStock({ onHand: 0, velocityPerDay: 5 })).toBe(0);
  });

  it("returns 0 when stock is negative (defensive)", () => {
    expect(computeDaysOfStock({ onHand: -5, velocityPerDay: 5 })).toBe(0);
  });
});
