import { describe, it, expect, vi } from "vitest";
import {
  runSheetPoll,
  type PolledSheet,
  type PollState,
  type SheetPollDeps,
} from "@/lib/jobs/sheet-poll";

// Two sheets: one "full"-class, one "light"-class. Tests inject Drive
// modifiedTimes + prior state directly, so nothing hits Google or the DB.
const SHEETS: PolledSheet[] = [
  { source: "sheets_inventory", sheetIdEnv: "INVENTORY_SHEET_ID", triggerClass: "full" },
  { source: "sheets_ad_spend", sheetIdEnv: "AD_SPEND_SHEET_ID", triggerClass: "light" },
];

const ENV = {
  INVENTORY_SHEET_ID: "inv-file-id",
  AD_SPEND_SHEET_ID: "ads-file-id",
};

function makeDeps(opts: {
  modified: Record<string, string | null | Error>;
  state?: Map<string, PollState>;
  now?: Date;
  lockMinutes?: number;
}): { deps: SheetPollDeps; trigger: ReturnType<typeof vi.fn>; written: unknown[] } {
  const trigger = vi.fn(async () => {});
  const written: unknown[] = [];
  const deps: SheetPollDeps = {
    sheets: SHEETS,
    env: ENV,
    now: () => opts.now ?? new Date("2026-06-09T12:00:00Z"),
    lockMinutes: opts.lockMinutes,
    getModifiedTime: async (fileId: string) => {
      // map file id back to source via env
      const key = Object.entries(ENV).find(([, v]) => v === fileId)?.[0];
      const source = SHEETS.find((s) => s.sheetIdEnv === key)!.source;
      const v = opts.modified[source];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    readState: async () => opts.state ?? new Map(),
    writeState: async (updates) => {
      written.push(...updates);
    },
    trigger,
  };
  return { deps, trigger, written };
}

describe("runSheetPoll", () => {
  it("baseline first run records modifiedTimes and fires nothing", async () => {
    const { deps, trigger } = makeDeps({
      modified: { sheets_inventory: "2026-06-09T11:00:00Z", sheets_ad_spend: "2026-06-09T11:00:00Z" },
      state: new Map(), // no prior state
    });
    const res = await runSheetPoll(deps);
    expect(res.changed).toEqual([]);
    expect(res.decision).toBe("none");
    expect(res.fired).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("no change when modifiedTimes match stored state", async () => {
    const state = new Map<string, PollState>([
      ["sheets_inventory", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
      ["sheets_ad_spend", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
    ]);
    const { deps, trigger } = makeDeps({
      modified: { sheets_inventory: "2026-06-09T11:00:00Z", sheets_ad_spend: "2026-06-09T11:00:00Z" },
      state,
    });
    const res = await runSheetPoll(deps);
    expect(res.changed).toEqual([]);
    expect(res.decision).toBe("none");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("a full-class sheet change fires a full ingest", async () => {
    const state = new Map<string, PollState>([
      ["sheets_inventory", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
      ["sheets_ad_spend", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
    ]);
    const { deps, trigger } = makeDeps({
      modified: { sheets_inventory: "2026-06-09T11:30:00Z", sheets_ad_spend: "2026-06-09T11:00:00Z" },
      state,
    });
    const res = await runSheetPoll(deps);
    expect(res.changed).toContain("sheets_inventory");
    expect(res.decision).toBe("full");
    expect(res.fired).toBe(true);
    expect(trigger).toHaveBeenCalledWith("full");
  });

  it("only an ad-spend change fires the light refresh", async () => {
    const state = new Map<string, PollState>([
      ["sheets_inventory", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
      ["sheets_ad_spend", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
    ]);
    const { deps, trigger } = makeDeps({
      modified: { sheets_inventory: "2026-06-09T11:00:00Z", sheets_ad_spend: "2026-06-09T11:45:00Z" },
      state,
    });
    const res = await runSheetPoll(deps);
    expect(res.changed).toEqual(["sheets_ad_spend"]);
    expect(res.decision).toBe("light");
    expect(trigger).toHaveBeenCalledWith("light");
  });

  it("full takes precedence when both a full and a light sheet change", async () => {
    const state = new Map<string, PollState>([
      ["sheets_inventory", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
      ["sheets_ad_spend", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
    ]);
    const { deps, trigger } = makeDeps({
      modified: { sheets_inventory: "2026-06-09T11:30:00Z", sheets_ad_spend: "2026-06-09T11:30:00Z" },
      state,
    });
    const res = await runSheetPoll(deps);
    expect(res.decision).toBe("full");
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith("full");
  });

  it("locks out a trigger that would stack on a recent one and keeps the change pending", async () => {
    const now = new Date("2026-06-09T12:00:00Z");
    const state = new Map<string, PollState>([
      [
        "sheets_inventory",
        {
          lastModifiedTime: "2026-06-09T11:00:00Z",
          lastTriggeredAt: new Date("2026-06-09T11:57:00Z"), // 3 min ago, inside 6-min lock
        },
      ],
      ["sheets_ad_spend", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
    ]);
    const { deps, trigger, written } = makeDeps({
      modified: { sheets_inventory: "2026-06-09T11:30:00Z", sheets_ad_spend: "2026-06-09T11:00:00Z" },
      state,
      now,
      lockMinutes: 6,
    });
    const res = await runSheetPoll(deps);
    expect(res.lockedOut).toBe(true);
    expect(res.fired).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
    // The changed sheet's stored modifiedTime must NOT advance, so the next
    // poll (after the lock clears) still detects the change and fires.
    const invRow = (written as Array<{ source: string; lastModifiedTime: string | null }>).find(
      (w) => w.source === "sheets_inventory",
    );
    expect(invRow?.lastModifiedTime).toBe("2026-06-09T11:00:00Z");
  });

  it("a Drive error on one sheet is recorded and does not block the others", async () => {
    const state = new Map<string, PollState>([
      ["sheets_inventory", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
      ["sheets_ad_spend", { lastModifiedTime: "2026-06-09T11:00:00Z", lastTriggeredAt: null }],
    ]);
    const { deps, trigger, written } = makeDeps({
      modified: {
        sheets_inventory: new Error("drive 503"),
        sheets_ad_spend: "2026-06-09T11:45:00Z",
      },
      state,
    });
    const res = await runSheetPoll(deps);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].source).toBe("sheets_inventory");
    // ad_spend still processed -> light fire
    expect(res.decision).toBe("light");
    expect(trigger).toHaveBeenCalledWith("light");
    // the errored sheet's state is not advanced (no row written for it)
    expect((written as Array<{ source: string }>).some((w) => w.source === "sheets_inventory")).toBe(
      false,
    );
  });

  it("skips sheets whose env id is not configured", async () => {
    const { deps, trigger } = makeDeps({
      modified: { sheets_inventory: "2026-06-09T11:00:00Z", sheets_ad_spend: "x" },
      state: new Map(),
    });
    // drop the ad-spend env id
    deps.env = { INVENTORY_SHEET_ID: "inv-file-id" };
    const res = await runSheetPoll(deps);
    expect(res.checked).toEqual(["sheets_inventory"]);
    expect(trigger).not.toHaveBeenCalled();
  });
});
