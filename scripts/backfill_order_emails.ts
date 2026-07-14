// One-shot: pull the full ~60-day order-email window from both Shopify
// stores, then stamp purchase_verified on every review. Idempotent.
// Usage: DATABASE_URL='<prod url>' pnpm tsx scripts/backfill_order_emails.ts
import "dotenv/config";
import { runPurchaseVerification } from "@/lib/jobs/shopify-order-emails";
import { unifyLooxProducts } from "@/lib/jobs/loox-product-unify";

const started = Date.now();
(async () => {
  const unify = await unifyLooxProducts();
  console.log("unify:", JSON.stringify(unify));
  const r = await runPurchaseVerification();
  console.log(JSON.stringify(r, null, 2));
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
