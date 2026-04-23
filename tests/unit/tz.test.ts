import { describe, it, expect } from "vitest";
import { estDayStart, estDayEnd, toEstDate, nowEst } from "@/lib/tz";

describe("tz helpers", () => {
  it("toEstDate returns YYYY-MM-DD for a UTC timestamp", () => {
    // 2026-04-22T02:30:00Z is 2026-04-21 22:30 EST (EDT is UTC-4)
    expect(toEstDate(new Date("2026-04-22T02:30:00Z"))).toBe("2026-04-21");
  });

  it("estDayStart returns midnight EST as a UTC Date", () => {
    // 2026-04-22 00:00 EDT == 2026-04-22T04:00:00Z
    const d = estDayStart("2026-04-22");
    expect(d.toISOString()).toBe("2026-04-22T04:00:00.000Z");
  });

  it("estDayEnd returns next-day midnight EST as a UTC Date", () => {
    const d = estDayEnd("2026-04-22");
    expect(d.toISOString()).toBe("2026-04-23T04:00:00.000Z");
  });

  it("nowEst returns a string shaped YYYY-MM-DD HH:mm:ss", () => {
    expect(nowEst()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
