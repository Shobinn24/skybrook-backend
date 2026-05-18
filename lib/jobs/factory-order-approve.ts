/**
 * Approve a Factory Order: run the calc engine one final time, snapshot
 * every per-SKU line into `factory_order_lines`, and lock the order
 * status to "approved".
 *
 * Spec: docs/factory-order-spec/factory-order-automation.md §7.2,
 * §9.2 (factory_order_lines), §9.6 step 3.
 *
 * Re-approving an approved order is a no-op (idempotent).
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { factoryOrders, factoryOrderLines } from "@/lib/db/schema";
import { calculateOrder } from "@/lib/queries/factory-order-calc";

export type ApproveResult = {
  orderId: string;
  status: "approved";
  lineCount: number;
  usTotal: number;
  intlTotal: number;
};

export async function approveFactoryOrder(opts: {
  orderId: string;
  approvedBy: string;
}): Promise<ApproveResult> {
  // Fetch the current calc result. We don't read inputs separately —
  // calculateOrder pulls everything fresh and runs the engine.
  const result = await calculateOrder({ orderId: opts.orderId });

  // Clean prior snapshot (if any), then bulk-insert. Doing a delete-
  // and-replace inside a transaction keeps the table consistent even
  // when a previous approve attempt half-wrote (e.g., disk full).
  await db.transaction(async (tx) => {
    await tx
      .delete(factoryOrderLines)
      .where(eq(factoryOrderLines.orderId, opts.orderId));

    const rows = result.lines.map((l) => ({
      orderId: opts.orderId,
      sku: l.sku,
      destination: l.side === "US" ? ("US" as const) : ("CN" as const),
      qty: l.qty,
      unitCost: l.unitCost.toFixed(4),
      amount: l.amount.toFixed(2),
      productGroup: l.groupName,
    }));

    if (rows.length > 0) {
      // Chunk so a 700-line insert doesn't blow Postgres' parameter cap.
      const chunkSize = 200;
      for (let i = 0; i < rows.length; i += chunkSize) {
        await tx.insert(factoryOrderLines).values(rows.slice(i, i + chunkSize));
      }
    }

    await tx
      .update(factoryOrders)
      .set({
        status: "approved",
        approvedAt: new Date(),
        approvedBy: opts.approvedBy,
        updatedAt: new Date(),
      })
      .where(eq(factoryOrders.id, opts.orderId));
  });

  return {
    orderId: opts.orderId,
    status: "approved",
    lineCount: result.lines.length,
    usTotal: result.totals.usAmount,
    intlTotal: result.totals.intlAmount,
  };
}
