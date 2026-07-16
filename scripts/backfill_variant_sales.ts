// One-shot: build variant_sales_monthly for full history, month by month
// (main from 2022-05, intl from 2024-07 — its first orders). Idempotent:
// each month's cells are recomputed and upserted.
// Usage: DATABASE_URL='<prod url>' pnpm tsx scripts/backfill_variant_sales.ts
import "dotenv/config";
import { syncVariantSales } from "@/lib/jobs/variant-sales-sync";

const START: Record<"main" | "intl", string> = { main: "2022-05-01", intl: "2024-07-01" };

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
    for (const [from, to] of months(START[store])) {
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        const r = await syncVariantSales(store, from, to);
        if (!r.error) {
          ok = true;
          console.log(`${store} ${from}: ${r.orders} orders -> ${r.cells} cells`);
        } else {
          console.log(`${store} ${from} attempt ${attempt} FAILED: ${r.error}`);
          await new Promise((res) => setTimeout(res, 30_000 * attempt));
        }
      }
      if (!ok) {
        console.error(`${store} ${from}: giving up after 3 attempts`);
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
