// Seeds the local dev DB with fixture data so the inventory dashboard has
// something to display. Uses the same `seedBasic` fixture the integration
// tests consume, then runs Phase 2 to derive velocity / DOS / sustainability
// flags. Safe to re-run — `resetDb` truncates first.

import "dotenv/config";
import { resetDb, seedBasic } from "@/tests/fixtures/seed";
import { runPhase2 } from "@/lib/jobs/reconcile";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — check your .env");
  }
  if (process.env.DATABASE_URL.includes("railway")) {
    throw new Error("Refusing to seed a Railway database — set DATABASE_URL to local postgres");
  }
  console.log("Resetting + seeding local dev DB…");
  await resetDb();
  await seedBasic();
  console.log("Running Phase 2 derive…");
  const result = await runPhase2({ asOfDate: "2026-04-23" });
  console.log(`Done. skusProcessed=${result.skusProcessed} skusSkipped=${result.skusSkipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("dev-seed failed:", err);
  process.exit(1);
});
