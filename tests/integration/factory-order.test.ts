import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { factoryOrders, factoryOrderInputs } from "@/lib/db/schema";
import {
  EMPTY_INPUTS,
  getOrCreateDraft,
  listOrders,
  monthKey,
  saveInputs,
} from "@/lib/queries/factory-order";
import { resetDb } from "@/tests/fixtures/seed";

/**
 * Phase 1 contract:
 *   (1) `monthKey` normalizes any day-in-month to the first.
 *   (2) `getOrCreateDraft` is idempotent across calls + day-of-month
 *       variants for the same calendar month.
 *   (3) Auto-save round-trips through every JSON column without
 *       losing fields.
 *   (4) `listOrders` returns newest-first.
 *
 * Approval-flow assertions land in Phase 2 once the calc engine
 * lands the snapshotted lines.
 */
describe("factory-order Phase 1 — schema + draft persistence", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("monthKey normalizes any day in the month to the first", () => {
    expect(monthKey("2026-05-01")).toBe("2026-05-01");
    expect(monthKey("2026-05-18")).toBe("2026-05-01");
    expect(monthKey("2026-05-31")).toBe("2026-05-01");
    expect(monthKey("2026-12-15")).toBe("2026-12-01");
  });

  it("getOrCreateDraft is idempotent for the same month", async () => {
    const a = await getOrCreateDraft("2026-05-18");
    const b = await getOrCreateDraft("2026-05-01");
    const c = await getOrCreateDraft("2026-05-31");
    expect(b.header.id).toBe(a.header.id);
    expect(c.header.id).toBe(a.header.id);
    expect(a.header.orderMonth).toBe("2026-05-01");
    expect(a.header.status).toBe("draft");

    const allRows = await db
      .select()
      .from(factoryOrders)
      .where(eq(factoryOrders.orderMonth, "2026-05-01"));
    expect(allRows).toHaveLength(1);
  });

  it("creates an inputs row alongside the order (defaults seeded)", async () => {
    const draft = await getOrCreateDraft("2026-05-01");
    expect(draft.inputs).toEqual(EMPTY_INPUTS);

    const inputRows = await db
      .select()
      .from(factoryOrderInputs)
      .where(eq(factoryOrderInputs.orderId, draft.header.id));
    expect(inputRows).toHaveLength(1);
  });

  it("saveInputs round-trips every field including JSON columns", async () => {
    const draft = await getOrCreateDraft("2026-05-01");

    const payload = {
      revenueUs: 2_138_175.3,
      revenueIntl: 812_386.59,
      revenueAmazon: 303_762.7,
      forecast: {
        us: [3_500_000, 3_500_000, 3_500_000, 4_100_000],
        intl: [4_000_000, 4_200_000, 4_500_000],
      },
      splits: {
        us: { "9055 Main": 0.55, "OG Main": 0.25, "HW Main": 0.23 },
        intl: { "9055 Main": 0.65, "OG Main": 0.1, "HW Main": 0.32 },
      },
      scaling: { Boyshort: 0.9, "9055 Main": 1.0 },
      customQtys: { "FC Super HW": 3000, "Cotton Hipster": 1500 },
      amazonData: {
        "ev-9055-5x-m": { sales30d: 250, stock: 100, hold: 20 },
      },
      comments: {
        "9055 Main": "Order based on calculations",
        "OG Main": "Safe at 1.2, no need to order",
      },
      orderNotes: "This needs to last until 4 Aug — when KAI May arrives",
    };

    await saveInputs({ orderId: draft.header.id, inputs: payload });

    const reloaded = await getOrCreateDraft("2026-05-15"); // same month, different day
    expect(reloaded.header.id).toBe(draft.header.id);
    expect(reloaded.inputs.revenueUs).toBeCloseTo(payload.revenueUs, 2);
    expect(reloaded.inputs.revenueIntl).toBeCloseTo(payload.revenueIntl, 2);
    expect(reloaded.inputs.revenueAmazon).toBeCloseTo(payload.revenueAmazon, 2);
    expect(reloaded.inputs.forecast).toEqual(payload.forecast);
    expect(reloaded.inputs.splits).toEqual(payload.splits);
    expect(reloaded.inputs.scaling).toEqual(payload.scaling);
    expect(reloaded.inputs.customQtys).toEqual(payload.customQtys);
    expect(reloaded.inputs.amazonData).toEqual(payload.amazonData);
    expect(reloaded.inputs.comments).toEqual(payload.comments);
    expect(reloaded.inputs.orderNotes).toBe(payload.orderNotes);
  });

  it("listOrders returns months newest-first", async () => {
    await getOrCreateDraft("2026-03-15");
    await getOrCreateDraft("2026-05-01");
    await getOrCreateDraft("2026-04-20");

    const all = await listOrders();
    expect(all.map((o) => o.orderMonth)).toEqual([
      "2026-05-01",
      "2026-04-01",
      "2026-03-01",
    ]);
  });
});
