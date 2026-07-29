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
import { detectAndInsertBonusCrossings } from "@/lib/jobs/bonus-crossings";
import {
  approveBonus,
  bulkApprovePending,
  rejectBonus,
  sendNotification,
} from "@/lib/jobs/bonus-mutations";
import { resetDb } from "@/tests/fixtures/seed";

async function makeRawPull(): Promise<string> {
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
  return raw.id;
}

async function seedAdSpend(opts: {
  adNumber: string;
  marketers: string[];
  totalCostUsd: number;
  sourcePullId: string;
}) {
  await db.insert(fbAdSpendDaily).values({
    adNumber: opts.adNumber,
    adName: `Ad ${opts.adNumber}`,
    adNameRaw: `Ad ${opts.adNumber}`,
    adLink: null,
    marketers: opts.marketers,
    spendDate: "2026-04-01",
    costUsd: opts.totalCostUsd.toFixed(4),
    sourcePullId: opts.sourcePullId,
  });
}

async function seedPending(adNumber: string, marketers: string[], totalCostUsd: number) {
  const rawId = await makeRawPull();
  await seedAdSpend({ adNumber, marketers, totalCostUsd, sourcePullId: rawId });
  await detectAndInsertBonusCrossings({ asOfDate: "2026-05-13" });
}

describe("approveBonus", () => {
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

  it("flips pending → approved_full at canonical rate", async () => {
    await seedPending("100", ["Craig"], 20_000);
    const [pending] = await db.select().from(bonusAwards);
    const result = await approveBonus({
      awardId: pending.id,
      approval: "approved_full",
      approvedBy: "jasper@skybrook",
    });
    expect(result.updated).toBe(true);

    const [after] = await db.select().from(bonusAwards);
    expect(after.status).toBe("approved_full");
    expect(Number(after.amountUsd)).toBe(500);
    expect(after.approvedAt).not.toBeNull();
    expect(after.approvedBy).toBe("jasper@skybrook");
  });

  it("re-computes amount when approved_half is chosen", async () => {
    await seedPending("200", ["Craig"], 70_000); // → pending T2 at full $3000 default
    const t2 = (await db.select().from(bonusAwards)).find((a) => a.tier === "tier2")!;

    await approveBonus({
      awardId: t2.id,
      approval: "approved_half",
      approvedBy: "jasper",
    });
    const [after] = await db.select().from(bonusAwards).where(sql`${bonusAwards.id} = ${t2.id}`);
    expect(after.status).toBe("approved_half");
    expect(Number(after.amountUsd)).toBe(1500); // half of $3000
  });

  it("is a no-op on already-approved awards", async () => {
    await seedPending("300", ["Craig"], 14_000);
    const [pending] = await db.select().from(bonusAwards);
    await approveBonus({
      awardId: pending.id,
      approval: "approved_full",
      approvedBy: "jasper",
    });
    const result = await approveBonus({
      awardId: pending.id,
      approval: "approved_half",
      approvedBy: "jasper",
    });
    expect(result.updated).toBe(false);
    const [after] = await db.select().from(bonusAwards);
    expect(after.status).toBe("approved_full"); // not flipped to half
  });
});

describe("approveBonus — video editor awards (flat \$200/\$800 rates)", () => {
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

  async function seedEditorPending(opts: {
    adNumber: string;
    editor: string;
    tier: "tier1" | "tier2";
  }) {
    const [row] = await db
      .insert(bonusAwards)
      .values({
        adNumber: opts.adNumber,
        marketer: opts.editor, // free-text column stores the editor display name
        tier: opts.tier,
        crossedAt: "2026-06-01",
        status: "pending",
        amountUsd: opts.tier === "tier1" ? "200.00" : "800.00",
      })
      .returning();
    return row;
  }

  it("approves an editor T1 at \$200 full / \$100 half", async () => {
    const t1 = await seedEditorPending({
      adNumber: "3001",
      editor: "Sebastian",
      tier: "tier1",
    });
    await approveBonus({
      awardId: t1.id,
      approval: "approved_full",
      approvedBy: "jasper",
    });
    let [after] = await db.select().from(bonusAwards);
    expect(after.status).toBe("approved_full");
    expect(Number(after.amountUsd)).toBe(200);

    await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
    const t1b = await seedEditorPending({
      adNumber: "3002",
      editor: "Phat Lee",
      tier: "tier1",
    });
    await approveBonus({
      awardId: t1b.id,
      approval: "approved_half",
      approvedBy: "jasper",
    });
    [after] = await db.select().from(bonusAwards);
    expect(after.status).toBe("approved_half");
    expect(Number(after.amountUsd)).toBe(100);
  });

  it("approves an editor T2 at \$800 full / \$400 half", async () => {
    const t2 = await seedEditorPending({
      adNumber: "3003",
      editor: "Greg",
      tier: "tier2",
    });
    await approveBonus({
      awardId: t2.id,
      approval: "approved_full",
      approvedBy: "jasper",
    });
    let [after] = await db.select().from(bonusAwards);
    expect(Number(after.amountUsd)).toBe(800);

    await db.execute(sql`TRUNCATE TABLE bonus_awards CASCADE`);
    const t2b = await seedEditorPending({
      adNumber: "3004",
      editor: "Ryan",
      tier: "tier2",
    });
    await approveBonus({
      awardId: t2b.id,
      approval: "approved_half",
      approvedBy: "jasper",
    });
    [after] = await db.select().from(bonusAwards);
    expect(Number(after.amountUsd)).toBe(400);
  });

  it("bulk-approve prices editor rows at editor rates and marketer rows at marketer rates", async () => {
    await seedPending("601", ["Craig"], 14_000); // marketer T1 → $500
    await seedEditorPending({
      adNumber: "601",
      editor: "Cristian",
      tier: "tier1", // editor T1 → $200 (dual credit on the same ad)
    });
    await seedEditorPending({
      adNumber: "3005",
      editor: "Job",
      tier: "tier2", // editor T2 → $800
    });

    const result = await bulkApprovePending({ approvedBy: "jasper" });
    expect(result.updatedCount).toBe(3);

    const rows = await db.select().from(bonusAwards);
    const amounts = rows.map((r) => Number(r.amountUsd)).sort((a, b) => a - b);
    expect(amounts).toEqual([200, 500, 800]);
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set(["approved_full"]),
    );
  });
});

describe("rejectBonus", () => {
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

  it("marks the award rejected", async () => {
    await seedPending("400", ["Craig"], 14_000);
    const [pending] = await db.select().from(bonusAwards);
    await rejectBonus({ awardId: pending.id, approvedBy: "jasper" });
    const [after] = await db.select().from(bonusAwards);
    expect(after.status).toBe("rejected");
  });

  it("refuses to reject an award already shipped in a notification", async () => {
    await seedPending("500", ["Craig"], 14_000);
    const [pending] = await db.select().from(bonusAwards);
    // Manually pretend it shipped
    await db
      .update(bonusAwards)
      .set({ status: "approved_full", notificationBatchId: randomUUID() })
      .where(sql`${bonusAwards.id} = ${pending.id}`);

    await expect(
      rejectBonus({ awardId: pending.id, approvedBy: "jasper" }),
    ).rejects.toThrow(/already shipped/);
  });
});

describe("bulkApprovePending", () => {
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

  it("flips every pending row to approved_full with canonical amount", async () => {
    await seedPending("600", ["Craig", "Raul"], 70_000); // 4 awards: T1+T2 for each
    expect((await db.select().from(bonusAwards)).length).toBe(4);

    const result = await bulkApprovePending({ approvedBy: "jasper" });
    expect(result.updatedCount).toBe(4);

    const rows = await db.select().from(bonusAwards);
    const statuses = new Set(rows.map((r) => r.status));
    expect(statuses).toEqual(new Set(["approved_full"]));
    // Both Craig and Raul are main-tier → $500 T1, $3000 T2
    const amounts = rows.map((r) => Number(r.amountUsd)).sort((a, b) => a - b);
    expect(amounts).toEqual([500, 500, 3000, 3000]);
  });
});

describe("sendNotification", () => {
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

  it("skips when there are no approved-unsent awards", async () => {
    const result = await sendNotification({ sentBy: "jasper" });
    expect(result).toEqual({ skipped: true, reason: "no unsent approved bonuses" });
  });

  it("creates a batch + stamps awards atomically", async () => {
    await seedPending("700", ["Craig"], 70_000); // 2 pending (T1 + T2)
    const awards = await db.select().from(bonusAwards);
    for (const a of awards) {
      await approveBonus({
        awardId: a.id,
        approval: "approved_full",
        approvedBy: "jasper",
      });
    }

    const result = await sendNotification({
      sentBy: "jasper",
      periodLabel: "April 2026",
      sendWhatsApp: async () => ({ ok: true }),
    });
    if (result.skipped) throw new Error("expected send, got skip");
    expect(result.awardCount).toBe(2);
    expect(result.whatsappStatus).toBe("sent");

    const after = await db.select().from(bonusAwards);
    expect(after.every((a) => a.notificationBatchId === result.batchId)).toBe(true);

    const [batch] = await db.select().from(bonusNotificationBatches);
    expect(batch.periodLabel).toBe("April 2026");
    expect(batch.messageBody).toContain("April 2026 Bonuses");
    expect(batch.messageBody).toContain("Craig");
    expect(batch.whatsappStatus).toBe("sent");
  });

  it("records failed whatsapp status when send fails", async () => {
    await seedPending("800", ["Craig"], 14_000);
    const [a] = await db.select().from(bonusAwards);
    await approveBonus({
      awardId: a.id,
      approval: "approved_full",
      approvedBy: "jasper",
    });

    const result = await sendNotification({
      sentBy: "jasper",
      sendWhatsApp: async () => ({ ok: false, reason: "mcp unreachable" }),
    });
    if (result.skipped) throw new Error("expected send, got skip");
    expect(result.whatsappStatus).toBe("failed:mcp unreachable");

    const [batch] = await db.select().from(bonusNotificationBatches);
    expect(batch.whatsappStatus).toBe("failed:mcp unreachable");
    // Awards still stamped — Jasper can copy the body manually.
    const [after] = await db.select().from(bonusAwards);
    expect(after.notificationBatchId).toBe(result.batchId);
  });

  it("does not re-include already-shipped awards on a second send", async () => {
    await seedPending("900", ["Craig"], 14_000);
    const [a] = await db.select().from(bonusAwards);
    await approveBonus({
      awardId: a.id,
      approval: "approved_full",
      approvedBy: "jasper",
    });
    const first = await sendNotification({
      sentBy: "jasper",
      sendWhatsApp: async () => ({ ok: true }),
    });
    if (first.skipped) throw new Error("expected first send");

    const second = await sendNotification({
      sentBy: "jasper",
      sendWhatsApp: async () => ({ ok: true }),
    });
    expect(second).toEqual({ skipped: true, reason: "no unsent approved bonuses" });
  });
});

describe("sendNotification — per-program batches (2026-07-29 split)", () => {
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

  async function seedApprovedEditorAward(editor: string) {
    const [row] = await db
      .insert(bonusAwards)
      .values({
        adNumber: "4001",
        marketer: editor,
        tier: "tier1",
        crossedAt: "2026-07-01",
        status: "approved_full",
        amountUsd: "200.00",
        approvedAt: new Date(),
        approvedBy: "jasper",
      })
      .returning();
    return row;
  }

  it("marketer batch leaves editor awards unclaimed; editor batch picks them up", async () => {
    await seedPending("710", ["Craig"], 14_000);
    const [m] = await db.select().from(bonusAwards);
    await approveBonus({
      awardId: m.id,
      approval: "approved_full",
      approvedBy: "jasper",
    });
    const editorAward = await seedApprovedEditorAward("Sebastian");

    const marketerSend = await sendNotification({
      sentBy: "jasper",
      periodLabel: "July 2026",
      program: "marketers",
      sendWhatsApp: async () => ({ ok: true }),
    });
    if (marketerSend.skipped) throw new Error("expected marketer send");
    expect(marketerSend.awardCount).toBe(1);
    expect(marketerSend.messageBody).toContain("Craig");
    expect(marketerSend.messageBody).not.toContain("Sebastian");
    expect(marketerSend.messageBody).toContain("July 2026 Bonuses");

    // Editor award untouched by the marketer batch
    const [editorAfter] = await db
      .select()
      .from(bonusAwards)
      .where(sql`marketer = 'Sebastian'`);
    expect(editorAfter.notificationBatchId).toBeNull();

    const editorSend = await sendNotification({
      sentBy: "jasper",
      periodLabel: "July 2026",
      program: "videoEditors",
      sendWhatsApp: async () => ({ ok: true }),
    });
    if (editorSend.skipped) throw new Error("expected editor send");
    expect(editorSend.awardCount).toBe(1);
    expect(editorSend.messageBody).toContain("July 2026 Video Editor Bonuses");
    expect(editorSend.messageBody).toContain("Sebastian");
    // No marketer roster in the editor message ($0 people are marketer-only)
    expect(editorSend.messageBody).not.toContain("Craig");

    const batches = await db.select().from(bonusNotificationBatches);
    expect(batches).toHaveLength(2);
    const byProgram = new Map(batches.map((b) => [b.program, b]));
    expect(byProgram.get("marketers")?.messageBody).toContain("Craig");
    expect(byProgram.get("videoEditors")?.messageBody).toContain("Sebastian");
    expect(editorAward.id).toBeTruthy();
  });

  it("editors-only totals_json carries only earning editors (no zero marketer roster)", async () => {
    await seedApprovedEditorAward("Sebastian");
    const send = await sendNotification({
      sentBy: "jasper",
      program: "videoEditors",
      sendWhatsApp: async () => ({ ok: true }),
    });
    if (send.skipped) throw new Error("expected send");
    const [batch] = await db.select().from(bonusNotificationBatches);
    const totals = batch.totalsJson as Array<{ marketer: string }>;
    expect(totals).toHaveLength(1);
    expect(totals[0].marketer).toBe("Sebastian");
  });

  it("history filters per program with legacy null batches filed under marketers", async () => {
    const { getNotificationHistory } = await import(
      "@/lib/queries/bonus-tracker"
    );
    await db.insert(bonusNotificationBatches).values([
      {
        periodLabel: "June 2026",
        messageBody: "legacy combined",
        totalsJson: [],
        sentBy: "jasper",
        whatsappStatus: "sent",
        program: null,
      },
      {
        periodLabel: "July 2026",
        messageBody: "marketers only",
        totalsJson: [],
        sentBy: "jasper",
        whatsappStatus: "sent",
        program: "marketers",
      },
      {
        periodLabel: "July 2026",
        messageBody: "editors only",
        totalsJson: [],
        sentBy: "jasper",
        whatsappStatus: "sent",
        program: "videoEditors",
      },
    ]);

    const marketerRows = await getNotificationHistory({ program: "marketers" });
    expect(marketerRows.map((r) => r.messageBody).sort()).toEqual([
      "legacy combined",
      "marketers only",
    ]);
    const editorRows = await getNotificationHistory({ program: "videoEditors" });
    expect(editorRows.map((r) => r.messageBody)).toEqual(["editors only"]);
    const allRows = await getNotificationHistory();
    expect(allRows).toHaveLength(3);
  });
});
