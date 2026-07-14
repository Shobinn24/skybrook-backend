import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { postDigestMessage } from "@/lib/notifications/slack";

// Morning ops digest — automates the SQL half of MANUAL_CHECKS.md (the
// A-to-M sweep) into one Slack message on the daily 9:00 UTC cron, so the
// checks run even on days nobody runs them by hand and the manual pass
// shrinks to reading one message. Each check is independent and
// best-effort: one failing query reports itself as needing attention
// rather than sinking the digest.

// Check I frozen baselines (MANUAL_CHECKS.md, post 06-17 regrain). The
// backfilled years must never drift — drift means the daily delete scope
// is leaking into history.
const FB_YEARLY_BASELINE: Record<number, { rows: number; usd: number }> = {
  2023: { rows: 19_090, usd: 2_285_440 },
  2024: { rows: 77_043, usd: 7_848_914 },
  2025: { rows: 98_462, usd: 8_895_805 },
};

export type DigestItem = {
  label: string;
  ok: boolean;
  detail: string;
};

export function formatDigest(dateLabel: string, items: DigestItem[]): string {
  const lines = items.map((i) => `${i.ok ? "✅" : "⚠️"} *${i.label}*: ${i.detail}`);
  const attention = items.filter((i) => !i.ok).length;
  const headline =
    attention === 0
      ? "all checks green"
      : `${attention} item${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention`;
  return [`*Skybrook morning digest — ${dateLabel}* (${headline})`, ...lines].join("\n");
}

async function check(
  label: string,
  fn: () => Promise<{ ok: boolean; detail: string }>,
): Promise<DigestItem> {
  try {
    const r = await fn();
    return { label, ...r };
  } catch (e) {
    return {
      label,
      ok: false,
      detail: `check errored: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
    };
  }
}

export async function gatherOpsDigest(now = new Date()): Promise<DigestItem[]> {
  const items: DigestItem[] = [];

  // A — phantom bonus crossings: pending awards created today whose ad
  // hasn't spent in 60+ days are backfill ghosts, not real crossings.
  items.push(
    await check("Phantom bonus crossings", async () => {
      const rows = await db.execute(sql`
        select b.ad_number, max(f.spend_date) as last_spend
        from bonus_awards b
        left join fb_ad_spend_daily f on f.ad_number = b.ad_number
        where b.status = 'pending' and b.created_at::date = current_date
        group by b.ad_number
        having coalesce(max(f.spend_date), '1970-01-01') < current_date - 60`);
      const n = rows.length;
      return n === 0
        ? { ok: true, detail: "none today" }
        : { ok: false, detail: `${n} pending award(s) created today on ads with no spend in 60d — reject via cleanup script` };
    }),
  );

  // C — missing landed cost (DB side; the live-sheet cross-check stays
  // manual because it needs the sheet credentials + judgment).
  items.push(
    await check("SKUs missing unit cost", async () => {
      const rows = await db.execute(sql`
        select count(*)::int as n from skus
        where active = true and unit_cost_usd is null`);
      const n = Number((rows[0] as { n: number }).n);
      return n === 0
        ? { ok: true, detail: "none" }
        : { ok: false, detail: `${n} active SKU(s) — cross-check the live sheet before pinging anyone (check C)` };
    }),
  );

  // F — schema drift alerts open.
  items.push(
    await check("Schema drift", async () => {
      const rows = await db.execute(sql`
        select count(*)::int as n from alert_events
        where resolved_at is null and dedup_key like 'schema_drift%'`);
      const n = Number((rows[0] as { n: number }).n);
      return n === 0 ? { ok: true, detail: "none open" } : { ok: false, detail: `${n} open drift alert(s)` };
    }),
  );

  // H — data pulls: every source succeeded within 30h.
  items.push(
    await check("Data pulls", async () => {
      const rows = (await db.execute(sql`
        select distinct on (source) source, status, finished_at
        from data_pulls order by source, finished_at desc nulls last`)) as Array<{
        source: string;
        status: string;
        finished_at: Date | null;
      }>;
      const bad = rows.filter(
        (r) =>
          r.status !== "success" ||
          !r.finished_at ||
          now.getTime() - new Date(r.finished_at).getTime() > 30 * 3_600_000,
      );
      return bad.length === 0
        ? { ok: true, detail: `all ${rows.length} sources fresh` }
        : { ok: false, detail: bad.map((b) => `${b.source}=${b.status}`).join(", ") };
    }),
  );

  // I — FB import integrity: historical years frozen.
  items.push(
    await check("FB history frozen", async () => {
      const rows = (await db.execute(sql`
        select extract(year from spend_date)::int as yr, count(*)::int as rows,
          round(sum(cost_usd)::numeric, 0)::int as usd
        from fb_ad_spend_daily group by 1`)) as Array<{ yr: number; rows: number; usd: number }>;
      const drift: string[] = [];
      for (const [yr, base] of Object.entries(FB_YEARLY_BASELINE)) {
        const row = rows.find((r) => Number(r.yr) === Number(yr));
        if (!row) drift.push(`${yr} missing`);
        else if (Number(row.rows) !== base.rows || Number(row.usd) !== base.usd)
          drift.push(`${yr}: ${row.rows} rows/$${row.usd} vs baseline ${base.rows}/$${base.usd}`);
      }
      return drift.length === 0
        ? { ok: true, detail: "2023-2025 match baseline" }
        : { ok: false, detail: `DRIFT — ${drift.join("; ")} (delete scope may be leaking, check I)` };
    }),
  );

  // J — bonus award totals (informational; changes come from real
  // approvals, so this is a figure to eyeball, not an invariant).
  items.push(
    await check("Bonus awards", async () => {
      const rows = (await db.execute(sql`
        select status, count(*)::int as n, coalesce(sum(amount_usd),0)::int as usd
        from bonus_awards group by status order by status`)) as Array<{
        status: string;
        n: number;
        usd: number;
      }>;
      const s = rows.map((r) => `${r.status} ${r.n}/$${Number(r.usd).toLocaleString("en-US")}`).join(" · ");
      return { ok: true, detail: s || "no rows" };
    }),
  );

  // L — launches raw-SKU leak.
  items.push(
    await check("Launches SKU leak", async () => {
      const rows = await db.execute(sql`
        select count(*)::int as n from product_launches where product_name like 'ev-%'`);
      const n = Number((rows[0] as { n: number }).n);
      return n === 0
        ? { ok: true, detail: "none" }
        : { ok: false, detail: `${n} raw ev-* row(s) leaked through the detector (check L)` };
    }),
  );

  // M — overdue unreceipted shipments with substantial arrival evidence.
  items.push(
    await check("Unreceipted arrivals", async () => {
      const rows = (await db.execute(sql`
        with overdue as (
          select shipment_name, destination, expected_arrival, sku, quantity
          from incoming_shipments
          where expected_arrival < current_date - interval '3 days'
            and not exists (
              select 1 from incoming_receipts r
              where r.shipment_name = incoming_shipments.shipment_name
                and r.destination = incoming_shipments.destination
                and r.expected_arrival = incoming_shipments.expected_arrival)
        ), baseline as (
          select distinct on (o.shipment_name, o.destination, o.sku)
            o.shipment_name, o.destination, o.expected_arrival, o.sku,
            o.quantity as expected, coalesce(ss.on_hand, 0) as baseline
          from overdue o
          left join stock_snapshots ss
            on ss.sku = o.sku and ss.location = o.destination
            and ss.snapshot_date <= o.expected_arrival - interval '5 days'
          order by o.shipment_name, o.destination, o.sku, ss.snapshot_date desc
        ), latest as (
          select distinct on (o.shipment_name, o.destination, o.sku)
            o.shipment_name, o.destination, o.sku, coalesce(ss.on_hand, 0) as current
          from overdue o
          left join stock_snapshots ss on ss.sku = o.sku and ss.location = o.destination
          order by o.shipment_name, o.destination, o.sku, ss.snapshot_date desc
        )
        select b.shipment_name,
          round(100.0 * sum(greatest(l.current - b.baseline, 0))::numeric
            / nullif(sum(b.expected), 0), 1) as pct
        from baseline b left join latest l using (shipment_name, destination, sku)
        group by b.shipment_name, b.destination, b.expected_arrival
        having round(100.0 * sum(greatest(l.current - b.baseline, 0))::numeric
          / nullif(sum(b.expected), 0), 1) >= 25`)) as Array<{ shipment_name: string; pct: number }>;
      return rows.length === 0
        ? { ok: true, detail: "no arrival evidence awaiting confirm" }
        : {
            ok: false,
            detail: rows.map((r) => `${r.shipment_name} ${r.pct}% arrived`).join(", ") + " — confirm in /incoming (check M)",
          };
    }),
  );

  // Open alerts summary (covers E/axon and anything else outstanding).
  items.push(
    await check("Open alerts", async () => {
      const rows = (await db.execute(sql`
        select severity, left(title, 70) as title,
          (current_date - fired_at::date)::int as days_open
        from alert_events where resolved_at is null order by fired_at`)) as Array<{
        severity: string;
        title: string;
        days_open: number;
      }>;
      return rows.length === 0
        ? { ok: true, detail: "none" }
        : {
            ok: false,
            detail: rows.map((r) => `[${r.severity} ${r.days_open}d] ${r.title}`).join(" · "),
          };
    }),
  );

  // Supermetrics feeder queries (from the state the freshness sweep writes).
  items.push(
    await check("Supermetrics queries", async () => {
      const rows = (await db.execute(sql`
        select label, status, last_refreshed_at from supermetrics_query_state
        order by label`)) as Array<{ label: string; status: string; last_refreshed_at: Date | null }>;
      if (rows.length === 0) return { ok: true, detail: "no state yet (first sweep pending)" };
      const bad = rows.filter((r) => r.status !== "pass");
      return bad.length === 0
        ? { ok: true, detail: `all ${rows.length} refreshed` }
        : { ok: false, detail: bad.map((b) => b.label).join(", ") + " stale/unreadable" };
    }),
  );

  return items;
}

export async function runOpsDigest(now = new Date()): Promise<{
  posted: boolean;
  attention: number;
}> {
  const items = await gatherOpsDigest(now);
  const text = formatDigest(now.toISOString().slice(0, 10), items);
  const posted = await postDigestMessage(text);
  const attention = items.filter((i) => !i.ok).length;
  logger.info("ops_digest.done", { posted, attention, items: items.length });
  return { posted, attention };
}
