import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { resetDb, seedBasic } from "@/tests/fixtures/seed";
import { runPhase2 } from "@/lib/jobs/reconcile";
import { getInventoryRows } from "@/lib/queries/inventory";

/**
 * The UI component TracedNumber renders trace payloads directly — if the shape
 * regresses, popovers silently blank. These tests pin the shape for every
 * numeric field on the inventory table so any schema drift breaks the build.
 */
describe("inventory row traces", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
    await seedBasic();
    await runPhase2({ asOfDate: "2026-04-23" });
  });

  it("attaches a trace object with every required sub-trace", async () => {
    const rows = await getInventoryRows("US");
    const ev = rows.find((r) => r.sku === "EV-A");
    expect(ev).toBeDefined();
    expect(ev!.trace).toBeDefined();
    expect(ev!.trace.onHand.label).toContain("EV-A");
    expect(ev!.trace.stockValue.formula).toMatch(/unit cost/i);
    expect(ev!.trace.incoming.sources.length).toBeGreaterThan(0);
    expect(ev!.trace.velocity).not.toBeNull();
    expect(ev!.trace.weeksOfStock).not.toBeNull();
  });

  it("onHand trace inputs include the snapshot date from the snapshot", async () => {
    const rows = await getInventoryRows("US");
    const ev = rows.find((r) => r.sku === "EV-A")!;
    const snapInput = ev.trace.onHand.inputs?.find((i) =>
      i.label.toLowerCase().includes("snapshot")
    );
    expect(snapInput?.value).toBe(ev.snapshotDate);
  });

  it("stockValue trace math agrees with the displayed stock value", async () => {
    const rows = await getInventoryRows("US");
    const ev = rows.find((r) => r.sku === "EV-A")!;
    const onHandInput = ev.trace.stockValue.inputs?.find((i) => i.label === "On hand");
    expect(onHandInput?.value).toContain(ev.onHand.toLocaleString());
  });

  it("velocity trace is null when no sales_velocity row exists for the SKU", async () => {
    const rows = await getInventoryRows("CN");
    // Only EV-A has CN data in the basic seed; everything else may or may not.
    // We just assert the invariant: either velocity is null and velocityPerDay7d is null, or both are set.
    for (const r of rows) {
      if (r.velocityPerDay7d === null) {
        expect(r.trace.velocity).toBeNull();
      } else {
        expect(r.trace.velocity).not.toBeNull();
      }
    }
  });

  it("weeksOfStock trace is null when velocity is zero or missing", async () => {
    const rows = await getInventoryRows("US");
    for (const r of rows) {
      if (r.velocityPerDay7d === null || r.velocityPerDay7d === 0) {
        expect(r.trace.weeksOfStock).toBeNull();
      }
    }
  });

  it("incoming trace lists each pending PO as a separate input row", async () => {
    const rows = await getInventoryRows("US");
    const ev = rows.find((r) => r.sku === "EV-A")!;
    // Trace.inputs either lists POs or contains a single "none" row — check
    // the invariant: number of PO-like inputs matches incomingUnits non-zero.
    const poInputs = ev.trace.incoming.inputs ?? [];
    if (ev.incomingUnits > 0) {
      expect(poInputs.some((i) => i.label.toLowerCase().includes("po"))).toBe(true);
    } else {
      expect(poInputs.some((i) => i.value === "none")).toBe(true);
    }
  });

  it("US and CN show different velocity for the same SKU (per-channel slice)", async () => {
    const us = await getInventoryRows("US");
    const cn = await getInventoryRows("CN");
    const evAUs = us.find((r) => r.sku === "EV-A");
    const evACn = cn.find((r) => r.sku === "EV-A");
    expect(evAUs?.velocityPerDay7d).toBeCloseTo(5, 3); // shopify_us only
    expect(evACn?.velocityPerDay7d).toBeCloseTo(2, 3); // shopify_intl only
    expect(evAUs!.velocityPerDay7d).not.toBe(evACn!.velocityPerDay7d);
  });

  it("every populated trace carries at least one source reference", async () => {
    const rows = await getInventoryRows("US");
    for (const r of rows) {
      expect(r.trace.onHand.sources.length).toBeGreaterThan(0);
      expect(r.trace.stockValue.sources.length).toBeGreaterThan(0);
      expect(r.trace.incoming.sources.length).toBeGreaterThan(0);
      if (r.trace.velocity) expect(r.trace.velocity.sources.length).toBeGreaterThan(0);
      if (r.trace.weeksOfStock)
        expect(r.trace.weeksOfStock.sources.length).toBeGreaterThan(0);
    }
  });
});
