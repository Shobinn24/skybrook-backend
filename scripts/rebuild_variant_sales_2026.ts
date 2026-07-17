// One-shot: rebuild variant_sales_monthly for 2026 after the mapper fix
// (Comfort Plus HW split out of Comfort Plus Std; French Cut titles mapped).
// Month cells are recomputed from scratch and upserted, so this is idempotent.
// Usage: DATABASE_URL='<prod url>' pnpm tsx scripts/rebuild_variant_sales_2026.ts
import "dotenv/config";
import { syncVariantSales } from "@/lib/jobs/variant-sales-sync";

function* months2026(): Generator<[string, string]> {
  let d = new Date("2026-01-01T00:00:00Z");
  const now = new Date();
  while (d <= now) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    yield [d.toISOString().slice(0, 10), next.toISOString().slice(0, 10)];
    d = next;
  }
}

(async () => {
  for (const store of ["main", "intl"] as const) {
    for (const [from, to] of months2026()) {
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
  console.log("2026 rebuild complete");
  process.exit(0);
})();
