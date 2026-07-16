// One-shot: pull 2026 refunds from Shopify (orders created since
// 2025-11-01 catch late refunds on older orders). Month-sliced with
// retries; idempotent at refund-id grain.
// Usage: DATABASE_URL='<prod url>' pnpm tsx scripts/backfill_shopify_refunds.ts
import "dotenv/config";
import { syncShopifyRefundsWindow } from "@/lib/jobs/shopify-refunds-sync";

function* months(fromIso: string): Generator<[string, string]> {
  let d = new Date(`${fromIso}T00:00:00Z`);
  const now = new Date();
  while (d <= now) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    yield [d.toISOString().slice(0, 10), next.toISOString().slice(0, 10)];
    d = next;
  }
}

(async () => {
  const started = Date.now();
  for (const store of ["main", "intl"] as const) {
    for (const [from, to] of months("2025-11-01")) {
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        const r = await syncShopifyRefundsWindow(store, from, to);
        if (!r.error) {
          ok = true;
          console.log(`${store} ${from}: ${r.orders} orders, ${r.refunds} refunds -> ${r.lines} lines`);
        } else {
          console.log(`${store} ${from} attempt ${attempt} FAILED: ${r.error}`);
          await new Promise((res) => setTimeout(res, 30_000 * attempt));
        }
      }
      if (!ok) {
        console.error(`${store} ${from}: giving up`);
        process.exit(1);
      }
    }
  }
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
