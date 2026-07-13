// One-shot backfill: walk the full Loox review history for both stores via
// the Merchant API sync job. Idempotent — safe to re-run; conflicts no-op.
// Usage: pnpm tsx scripts/backfill-loox.ts
import "dotenv/config";
import { runLooxApiSync } from "@/lib/jobs/loox-api-sync";

const started = Date.now();
runLooxApiSync({ full: true })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
