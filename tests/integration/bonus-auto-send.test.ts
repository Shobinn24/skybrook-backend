import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bonusAwards,
  bonusNotificationBatches,
  fbAdSpendDaily,
  rawPulls,
} from "@/lib/db/schema";
import {
  previousMonthOf,
  runMonthlyBonusAutoSend,
} from "@/lib/jobs/bonus-auto-send";
import { resetDb } from "@/tests/fixtures/seed";

// 2026-05-01 12:00 EST == 16:00 UTC — mid-day on the 1st.
const FIRST_OF_MAY = new Date("2026-05-01T16:00:00Z");

async function seedSpend(opts: {
  adNumber: string;
  marketers: string[];
  totalCostUsd: number;
  spendDate: string;
  adNameRaw?: string;
}) {
  const [raw] = await db
    .insert(rawPulls)
    .values({
      source: "sheets_fb_ads",
      pullBatchId: randomUUID(),
      payload: {},
      rowCount: 0,
      schemaFingerprint: "fp",
    })
    .returning({ id: rawPulls.id });
  await db.insert(fbAdSpendDaily).values({
    adNumber: opts.adNumber,
    adName: `Ad ${opts.adNumber}`,
    adNameRaw: opts.adNameRaw ?? `Ad ${opts.adNumber}`,
    adLink: null,
    marketers: opts.marketers,
    spendDate: opts.spendDate,
    costUsd: opts.totalCostUsd.toFixed(4),
    sourcePullId: raw.id,
  });
}

const okSender = async () => ({ ok: true });

describe("previousMonthOf", () => {
  it("labels the month that just ended, with its last day", () => {
    expect(previousMonthOf("2026-08-01")).toEqual({
      periodLabel: "July 2026",
      lastDay: "2026-07-31",
    });
    expect(previousMonthOf("2026-01-01")).toEqual({
      periodLabel: "December 2025",
      lastDay: "2025-12-31",
    });
    expect(previousMonthOf("2026-03-01")).toEqual({
      periodLabel: "February 2026",
      lastDay: "2026-02-28",
    });
  });
});

describe("runMonthlyBonusAutoSend", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL not set in test env");
  });

  beforeEach(async () => {
    await resetDb();
    await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
    await db.execute(sql`TRUNCATE TABLE bonus_notification_batches CASCADE`);
    await db.execute(sql`TRUNCATE TABLE data_pulls CASCADE`);
  });

  it("refuses when the env gate is off", async () => {
    const res = await runMonthlyBonusAutoSend({
      now: FIRST_OF_MAY,
      enabled: false,
      sendWhatsApp: okSender,
    });
    expect(res.ran).toBe(false);
    expect(res.reason).toMatch(/BONUS_AUTO_SEND_ENABLED/);
  });

  it("refuses on any day but the 1st", async () => {
    const res = await runMonthlyBonusAutoSend({
      now: new Date("2026-05-02T16:00:00Z"),
      enabled: true,
      sendWhatsApp: okSender,
    });
    expect(res.ran).toBe(false);
    expect(res.reason).toMatch(/not the 1st/);
  });

  it("waits when spend has not synced through the last day of the month", async () => {
    await seedSpend({
      adNumber: "800",
      marketers: ["Craig"],
      totalCostUsd: 20_000,
      spendDate: "2026-04-28", // last day 04-30 not synced yet
    });
    const res = await runMonthlyBonusAutoSend({
      now: FIRST_OF_MAY,
      enabled: true,
      sendWhatsApp: okSender,
    });
    expect(res.ran).toBe(false);
    expect(res.reason).toMatch(/not synced through 2026-04-30/);
    // nothing approved, nothing sent
    expect((await db.select().from(bonusNotificationBatches)).length).toBe(0);
  });

  it("detects, auto-approves (half rules honored), and sends both programs once", async () => {
    await seedSpend({
      adNumber: "801",
      marketers: ["Craig"],
      totalCostUsd: 20_000,
      spendDate: "2026-04-30",
      adNameRaw: "(HW) Ad 801 - AIad - SR - Craig VID 1 Rehook",
    });
    const sent: string[] = [];
    const res = await runMonthlyBonusAutoSend({
      now: FIRST_OF_MAY,
      enabled: true,
      sendWhatsApp: async (body) => {
        sent.push(body);
        return { ok: true };
      },
    });
    expect(res.ran).toBe(true);
    expect(res.periodLabel).toBe("April 2026");
    // Craig T1 (auto-half via Rehook) + Sebastian editor T1
    expect(res.approved).toBe(2);
    expect(res.programs?.marketers.sent).toBe(true);
    expect(res.programs?.videoEditors.sent).toBe(true);
    expect(sent.length).toBe(2);

    const awards = await db.select().from(bonusAwards);
    const craig = awards.find((a) => a.marketer === "Craig")!;
    const seb = awards.find((a) => a.marketer === "Sebastian")!;
    expect(craig.status).toBe("approved_half");
    expect(Number(craig.amountUsd)).toBe(250);
    expect(seb.status).toBe("approved_full");
    expect(craig.notificationBatchId).not.toBeNull();
    expect(seb.notificationBatchId).not.toBeNull();

    // retry the same day: both programs skip via once-per-month guard
    const retry = await runMonthlyBonusAutoSend({
      now: FIRST_OF_MAY,
      enabled: true,
      sendWhatsApp: okSender,
    });
    expect(retry.ran).toBe(true);
    expect(retry.programs?.marketers.sent).toBe(false);
    expect(retry.programs?.marketers.reason).toMatch(/already exists/);
    expect(retry.programs?.videoEditors.sent).toBe(false);
    expect((await db.select().from(bonusNotificationBatches)).length).toBe(2);
  });
});
