// Daily sweep that deactivates orphan SKU rows — rows created by the
// incoming-shipments upsert (lib/sources/sheets.ts: see comment at the
// `seenSkus` loop) that were never resolved to actual inventory.
//
// Background: when a new SKU first appears on the Incoming sheet, the
// runner upserts it into `skus` (active=true, productLine=null) so
// runLaunchAutoPopulate's innerJoin can pick it up immediately. Once
// physical stock lands, the inventory runner backfills productLine and
// the SKU becomes a real catalog entry.
//
// The trap: if that SKU is later removed from the Incoming sheet
// (canonicalization rename, e.g. ev-pp-hw-* → ev-hw-*; or sheet edit
// before any stock was received), the incoming_shipments row is gone
// (delete+reinsert per pull), but the skus row stays around forever —
// active=true, productLine=null, never priced, never stocked. By
// 2026-05-28 13 such rows had accumulated and inflated /api/health's
// missing-cost count, masking the genuine 42 awaiting Grace.
//
// This job runs after the daily ingest and deactivates any row that
// matches all of:
//   - active=true, unit_cost_usd IS NULL, product_line IS NULL
//   - zero stock_snapshots history (the SKU never physically arrived)
//   - zero current incoming_shipments references (post-truncate)
//   - zero factory_order_lines references
//   - first_seen_at older than MIN_AGE_DAYS (don't deactivate
//     brand-new SKUs whose first inventory pull just hasn't run yet)
//
// Soft-deactivate (active=false) rather than DELETE so the audit
// trail survives and the incoming upsert's onConflictDoUpdate path
// flips active=true if Grace later re-adds the SKU. Idempotent on
// repeat runs.

import { and, eq, exists, inArray, isNull, lt, not, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  factoryOrderLines,
  incomingShipments,
  skus,
  stockSnapshots,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger";

/** A SKU must have existed for at least this many days before the sweep
 * considers it orphan. Tolerates the lag between a brand-new SKU being
 * added to the Incoming sheet and the first inventory pull that gives
 * it stock. KAI POs typically have multi-week lead times — 30 days
 * comfortably covers the longest gap observed in 2026. */
export const MIN_AGE_DAYS = 30;

export type OrphanSweepResult = {
  /** SKU codes whose active flag was flipped from true to false. */
  deactivated: string[];
};

function ymdDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function runOrphanSkuSweep(): Promise<OrphanSweepResult> {
  const cutoff = ymdDaysAgo(MIN_AGE_DAYS);

  // Select-then-update so we can return the exact SKU list for
  // observability and so the integration test can assert on it. The
  // candidate set is small (single-digit per run in steady state),
  // so the round trip cost is negligible.
  const candidates = await db
    .select({ sku: skus.sku })
    .from(skus)
    .where(
      and(
        eq(skus.active, true),
        isNull(skus.unitCostUsd),
        isNull(skus.productLine),
        lt(skus.firstSeenAt, cutoff),
        not(
          exists(
            db
              .select({ x: sql`1` })
              .from(stockSnapshots)
              .where(eq(stockSnapshots.sku, skus.sku)),
          ),
        ),
        not(
          exists(
            db
              .select({ x: sql`1` })
              .from(incomingShipments)
              .where(eq(incomingShipments.sku, skus.sku)),
          ),
        ),
        not(
          exists(
            db
              .select({ x: sql`1` })
              .from(factoryOrderLines)
              .where(eq(factoryOrderLines.sku, skus.sku)),
          ),
        ),
      ),
    );

  if (candidates.length === 0) {
    return { deactivated: [] };
  }

  const target = candidates.map((c) => c.sku);
  await db.update(skus).set({ active: false }).where(inArray(skus.sku, target));

  logger.info("orphan-sku-sweep.deactivated", {
    count: target.length,
    skus: target,
    minAgeDays: MIN_AGE_DAYS,
  });

  return { deactivated: target };
}
