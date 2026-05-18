/**
 * Persistence layer for the Factory Order Automation feature.
 *
 * Phase 1 — schema + draft management only. Phase 2 will add the
 * calc engine that consumes the inputs + existing Skybrook tables
 * (daily_sales, stock_snapshots, incoming_shipments, skus) and
 * produces the per-SKU line breakdown.
 *
 * Spec: docs/factory-order-spec/factory-order-automation.md §6, §9.2
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  factoryOrders,
  factoryOrderInputs,
} from "@/lib/db/schema";

// ---------------------------------------------------------------------
// Input shape — what the dashboard saves
// ---------------------------------------------------------------------

/**
 * Forward-looking revenue projection. US uses 4 months, INTL uses 3.
 * Spec §6.2 — Skybrook only needs the totals for the calc, but storing
 * per-month numbers keeps the audit trail honest and lets the UI render
 * the original four cells.
 */
export type ForecastJson = {
  us: number[]; // length 4
  intl: number[]; // length 3
};

/**
 * Main-line split overrides per warehouse. The 3 main-line product
 * groups should each have a number between 0 and 1; the three should
 * sum to ~1.0 per warehouse.
 * Spec §6.3.
 */
export type SplitsJson = {
  us: Record<string, number>;
  intl: Record<string, number>;
};

/** Per-product-group scaling factor. Defaults 1.0 when absent. */
export type ScalingJson = Record<string, number>;

/** Per-custom-product manual total. */
export type CustomQtysJson = Record<string, number>;

/** Per-SKU Amazon inputs (US-only manual entry). */
export type AmazonDataJson = Record<
  string,
  {
    sales30d?: number;
    stock?: number;
    hold?: number;
  }
>;

/** Per-product-group free text. */
export type CommentsJson = Record<string, string>;

/**
 * The full input panel for one factory order. Used both by the
 * dashboard for save-state and by the calc engine in Phase 2.
 */
export type FactoryOrderInputs = {
  revenueUs: number | null;
  revenueIntl: number | null;
  revenueAmazon: number | null;
  forecast: ForecastJson;
  splits: SplitsJson;
  scaling: ScalingJson;
  customQtys: CustomQtysJson;
  amazonData: AmazonDataJson;
  comments: CommentsJson;
  orderNotes: string | null;
};

export const EMPTY_INPUTS: FactoryOrderInputs = {
  revenueUs: null,
  revenueIntl: null,
  revenueAmazon: null,
  forecast: { us: [0, 0, 0, 0], intl: [0, 0, 0] },
  splits: { us: {}, intl: {} },
  scaling: {},
  customQtys: {},
  amazonData: {},
  comments: {},
  orderNotes: null,
};

export type FactoryOrderHeader = {
  id: string;
  orderMonth: string; // YYYY-MM-DD (first of month)
  status: "draft" | "approved";
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------

/**
 * Normalize "any date in the month" to the canonical first-of-month
 * key we store. The dashboard's month picker can send either the 1st
 * or any day in the month; both should land on the same row.
 */
export function monthKey(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(`${d.slice(0, 7)}-01T00:00:00Z`) : d;
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

function rowToHeader(
  row: typeof factoryOrders.$inferSelect,
): FactoryOrderHeader {
  return {
    id: row.id,
    orderMonth: row.orderMonth,
    status: row.status,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToInputs(
  row: typeof factoryOrderInputs.$inferSelect,
): FactoryOrderInputs {
  // Merge persisted JSON over EMPTY_INPUTS shape so newly-added
  // keys default cleanly instead of crashing downstream consumers.
  return {
    revenueUs: row.revenueUs !== null ? Number(row.revenueUs) : null,
    revenueIntl: row.revenueIntl !== null ? Number(row.revenueIntl) : null,
    revenueAmazon: row.revenueAmazon !== null ? Number(row.revenueAmazon) : null,
    forecast: { ...EMPTY_INPUTS.forecast, ...((row.forecastJson as object) ?? {}) } as ForecastJson,
    splits: { ...EMPTY_INPUTS.splits, ...((row.splitsJson as object) ?? {}) } as SplitsJson,
    scaling: (row.scalingJson as ScalingJson) ?? {},
    customQtys: (row.customQtysJson as CustomQtysJson) ?? {},
    amazonData: (row.amazonDataJson as AmazonDataJson) ?? {},
    comments: (row.commentsJson as CommentsJson) ?? {},
    orderNotes: row.orderNotes,
  };
}

/**
 * Idempotent — looks up or creates a draft order for the given month.
 * Returns header + inputs ready for the dashboard panel.
 */
export async function getOrCreateDraft(orderMonth: string): Promise<{
  header: FactoryOrderHeader;
  inputs: FactoryOrderInputs;
}> {
  const key = monthKey(orderMonth);

  const existing = await db
    .select()
    .from(factoryOrders)
    .where(eq(factoryOrders.orderMonth, key))
    .limit(1);

  let headerRow: typeof factoryOrders.$inferSelect;
  if (existing.length > 0) {
    headerRow = existing[0];
  } else {
    const inserted = await db
      .insert(factoryOrders)
      .values({ orderMonth: key, status: "draft" })
      .returning();
    headerRow = inserted[0];
    await db
      .insert(factoryOrderInputs)
      .values({ orderId: headerRow.id })
      .onConflictDoNothing();
  }

  const inputRows = await db
    .select()
    .from(factoryOrderInputs)
    .where(eq(factoryOrderInputs.orderId, headerRow.id))
    .limit(1);

  const inputs =
    inputRows.length > 0 ? rowToInputs(inputRows[0]) : EMPTY_INPUTS;

  return {
    header: rowToHeader(headerRow),
    inputs,
  };
}

/**
 * Persist edits to the input panel. Approved orders are read-only —
 * the caller (tRPC route) is expected to enforce this with a clean
 * error message; this layer trusts the status check has run.
 */
export async function saveInputs(opts: {
  orderId: string;
  inputs: FactoryOrderInputs;
}): Promise<void> {
  await db
    .update(factoryOrderInputs)
    .set({
      revenueUs:
        opts.inputs.revenueUs !== null
          ? opts.inputs.revenueUs.toFixed(2)
          : null,
      revenueIntl:
        opts.inputs.revenueIntl !== null
          ? opts.inputs.revenueIntl.toFixed(2)
          : null,
      revenueAmazon:
        opts.inputs.revenueAmazon !== null
          ? opts.inputs.revenueAmazon.toFixed(2)
          : null,
      forecastJson: opts.inputs.forecast,
      splitsJson: opts.inputs.splits,
      scalingJson: opts.inputs.scaling,
      customQtysJson: opts.inputs.customQtys,
      amazonDataJson: opts.inputs.amazonData,
      commentsJson: opts.inputs.comments,
      orderNotes: opts.inputs.orderNotes,
      updatedAt: new Date(),
    })
    .where(eq(factoryOrderInputs.orderId, opts.orderId));

  await db
    .update(factoryOrders)
    .set({ updatedAt: new Date() })
    .where(eq(factoryOrders.id, opts.orderId));
}

/**
 * List orders newest-first for the picker. Phase 1 returns just the
 * header; Phase 2 will layer on aggregate totals.
 */
export async function listOrders(): Promise<FactoryOrderHeader[]> {
  const rows = await db
    .select()
    .from(factoryOrders)
    .orderBy(factoryOrders.orderMonth);
  // orderBy default is ASC; sort desc for newest-first display.
  return [...rows].reverse().map(rowToHeader);
}
