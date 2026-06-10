import { router, opsProcedure } from "@/lib/trpc/server";
import { getShippingPerformanceView } from "@/lib/queries/shipping-audit";

export const shippingAuditRouter = router({
  // Page-feeding endpoint for /shipping-performance.
  // Spec: docs/shipping-checks-spec/ops-shipping-checks-spec.md
  //
  // Returns the stats panel (current 30d window + prior 30d + deltas
  // + histogram) plus the fulfilment SLA and carrier transit flag
  // lists. Flags are computed live each call against current Shopify
  // state; stats are read from the persisted daily snapshot but
  // overridden by a live recompute when Shopify is reachable.
  getView: opsProcedure.query(() => getShippingPerformanceView()),
});
