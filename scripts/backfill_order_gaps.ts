// Gap-filler: walks explicit created_at windows in MONTH slices with
// per-slice retries, so a dropped DB connection (which killed both
// full-history walks ~2h in on 2026-07-15) costs one month, not the run.
// Then restamps purchase verification.
// Usage: DATABASE_URL='<prod url>' pnpm tsx scripts/backfill_order_gaps.ts
import "dotenv/config";
import { syncOrderEmails, verifyReviewPurchases } from "@/lib/jobs/shopify-order-emails";

const GAPS: Array<{ stores: Array<"main" | "intl">; from: string; toExclusive: string }> = [
  { stores: ["main"], from: "2024-09-01", toExclusive: "2026-05-01" },
  { stores: ["intl"], from: "2026-03-01", toExclusive: "2026-05-01" },
];

function* monthSlices(from: string, toExclusive: string) {
  let cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${toExclusive}T00:00:00Z`);
  while (cur < end) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    yield {
      from: cur.toISOString().slice(0, 10),
      toExclusive: (next < end ? next : end).toISOString().slice(0, 10),
    };
    cur = next;
  }
}

const started = Date.now();
(async () => {
  for (const gap of GAPS) {
    for (const slice of monthSlices(gap.from, gap.toExclusive)) {
      for (let attempt = 1; ; attempt++) {
        const r = await syncOrderEmails({ ...slice, stores: gap.stores });
        const errs = r.stores.filter((s) => s.error);
        if (!errs.length) {
          console.log(`${gap.stores.join("+")} ${slice.from}: ok`, JSON.stringify(r.stores));
          break;
        }
        if (attempt >= 3) {
          console.error(`${gap.stores.join("+")} ${slice.from}: FAILED after 3 attempts`, JSON.stringify(errs));
          process.exit(1);
        }
        console.warn(`${gap.stores.join("+")} ${slice.from}: retry ${attempt}`, JSON.stringify(errs));
        await new Promise((res) => setTimeout(res, 10_000 * attempt));
      }
    }
  }
  const verify = await verifyReviewPurchases();
  console.log("verify:", JSON.stringify(verify));
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
