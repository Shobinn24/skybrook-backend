import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxProducts } from "@/lib/db/schema";
import { displayNameForProduct, lineForProduct } from "@/lib/jobs/loox-api-sync";
import { logger } from "@/lib/logger";

// Post-sync unify pass over the loox_products mapping (Scott 2026-07-14).
//
// RENAME AUTO-MERGE — a renamed Shopify product keeps its product id, so a
// review group that splits across titles ("French Cut" vs "High Cut",
// "Shapewear" vs "Shaping Brief") shares product_ids across the split.
// Every review row snapshots the product's CURRENT title at sync time, so
// the newest review in a product-id group carries the product's current
// name. For each product id, every unpinned handle is snapped to the
// display name derived from that newest title — merging old and new names
// into one line, under the name Scott sees in Shopify today.
//
// NOISE RULES — unpinned handles whose display name looks like a gift /
// mystery item are excluded from the table; display groups with fewer than
// 3 published reviews all-time are excluded too (and automatically
// re-included the moment they reach 3). Pinned rows are never touched, so
// hand-curated merges and exclusions survive every sync.

const GIFT_PATTERN = /mystery|free gift|\bgift\b/i;
const MIN_GROUP_REVIEWS = 3;

export type UnifyResult = {
  renamed: number;
  excluded: number;
  restored: number;
};

export async function unifyLooxProducts(): Promise<UnifyResult> {
  const result: UnifyResult = { renamed: 0, excluded: 0, restored: 0 };

  // Newest review title per product id + the handles that id spans.
  const groups = (await db.execute(sql`
    with newest as (
      select distinct on (product_id) product_id, product_title
      from loox_reviews
      where product_id is not null and product_title is not null
      order by product_id, coalesce(reviewed_at, received_at) desc
    )
    select n.product_id, n.product_title,
      array_agg(distinct r.product_handle) as handles
    from newest n
    join loox_reviews r on r.product_id = n.product_id
    where r.product_handle is not null
    group by 1, 2`)) as unknown as Array<{
    product_id: string;
    product_title: string;
    handles: string[];
  }>;

  const mappings = await db.select().from(looxProducts);
  const byHandle = new Map(mappings.map((m) => [m.handle, m]));

  for (const g of groups) {
    const canonicalName = displayNameForProduct(g.product_title);
    for (const handle of g.handles) {
      const row = byHandle.get(handle);
      if (!row || row.pinned) continue;
      const canonicalLine = lineForProduct(g.product_title, handle);
      if (row.displayName !== canonicalName || row.line !== canonicalLine) {
        await db
          .update(looxProducts)
          .set({ displayName: canonicalName, line: canonicalLine })
          .where(eq(looxProducts.handle, handle));
        row.displayName = canonicalName;
        row.line = canonicalLine;
        result.renamed += 1;
      }
    }
  }

  // Published review count per display group (all-time — a date filter in
  // the UI must not toggle inclusion).
  const counts = (await db.execute(sql`
    select lp.display_name, count(*) filter (where r.status = 'published')::int as n_pub
    from loox_products lp
    left join loox_reviews r on r.product_handle = lp.handle
    group by 1`)) as unknown as Array<{ display_name: string; n_pub: number }>;
  const pubByName = new Map(counts.map((c) => [c.display_name, Number(c.n_pub)]));

  for (const row of byHandle.values()) {
    if (row.pinned) continue;
    const isGift = GIFT_PATTERN.test(row.displayName);
    const groupPub = pubByName.get(row.displayName) ?? 0;
    const shouldInclude = !isGift && groupPub >= MIN_GROUP_REVIEWS;
    if (row.include !== shouldInclude) {
      await db
        .update(looxProducts)
        .set({ include: shouldInclude })
        .where(eq(looxProducts.handle, row.handle));
      if (shouldInclude) result.restored += 1;
      else result.excluded += 1;
    }
  }

  logger.info("loox.unify.done", { ...result, groups: groups.length });
  return result;
}
