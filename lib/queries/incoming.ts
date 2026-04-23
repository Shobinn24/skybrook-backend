import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { incomingShipments } from "@/lib/db/schema";
import type { Location } from "@/lib/domain/warehouse-routing";

export async function getIncomingStock(filters: { sku?: string; location?: Location } = {}) {
  return db
    .select()
    .from(incomingShipments)
    .where(
      and(
        filters.sku ? eq(incomingShipments.sku, filters.sku) : sql`true`,
        filters.location ? eq(incomingShipments.destination, filters.location) : sql`true`
      )
    )
    .orderBy(asc(incomingShipments.expectedArrival));
}
