// One-shot: walk the COMPLETE draft-sourced order history from both
// Shopify stores (filtered on source_name:shopify_draft_order, back to
// 2022-05) into draft_source_orders. Idempotent — re-runs no-op on the
// (store, shopify_order_id) unique index. Incremental upkeep rides
// runPurchaseVerification's cron slot after this initial fill.
// Usage: DATABASE_URL='<prod url>' pnpm tsx scripts/backfill_draft_orders.ts
import "dotenv/config";
import { syncDraftSourceOrders } from "@/lib/jobs/shopify-order-emails";

const started = Date.now();
(async () => {
  const result = await syncDraftSourceOrders({ fullHistory: true });
  console.log("draft orders backfill:", JSON.stringify(result, null, 2));
  console.log(`elapsed: ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(result.stores.some((s) => s.error) ? 1 : 0);
})();
