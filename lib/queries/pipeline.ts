import { desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { dataPulls } from "@/lib/db/schema";

export async function getLatestPullsPerSource() {
  const rows = await db.select().from(dataPulls).orderBy(desc(dataPulls.startedAt));
  const seen = new Set<string>();
  const latest: typeof rows = [];
  for (const r of rows) {
    if (seen.has(r.source)) continue;
    seen.add(r.source);
    latest.push(r);
  }
  return latest;
}
