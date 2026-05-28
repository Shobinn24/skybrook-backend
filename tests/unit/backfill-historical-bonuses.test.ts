import { describe, it, expect } from "vitest";
import {
  detectHalfBonusMismatches,
  parseMarketerTab,
  parsePaidCell,
  parsePaidDateCell,
  parseSummaryTab,
} from "@/lib/jobs/backfill-historical-bonuses";

describe("parsePaidDateCell (back-compat shim)", () => {
  it("returns the iso date for full and half date cells", () => {
    expect(parsePaidDateCell("30 Jan 25")).toBe("2025-01-30");
    expect(parsePaidDateCell("30 Mar 2026")).toBe("2026-03-30");
    expect(parsePaidDateCell("30 Apr 26")).toBe("2026-04-30");
    expect(parsePaidDateCell("1 February 2026")).toBe("2026-02-01");
    expect(parsePaidDateCell("1/30/2026")).toBe("2026-01-30");
    // Post-2026-05-28: 50% suffix also returns its date via the shim.
    expect(parsePaidDateCell("30 Jul 25 50%")).toBe("2025-07-30");
  });

  it("returns null when no date is parseable", () => {
    expect(parsePaidDateCell("")).toBeNull();
    expect(parsePaidDateCell(null)).toBeNull();
    expect(parsePaidDateCell(undefined)).toBeNull();
    expect(parsePaidDateCell("Yes")).toBeNull(); // Yes is paid_full but date-less
    expect(parsePaidDateCell("TBD")).toBeNull();
    expect(parsePaidDateCell("NA")).toBeNull(); // NA is reject, no date
    expect(parsePaidDateCell("32 Jan 26")).toBeNull();
    expect(parsePaidDateCell("30 Xyz 26")).toBeNull();
  });
});

describe("parsePaidCell (Yes / NA / X 50% / date)", () => {
  it("Yes → paid_full with no date", () => {
    expect(parsePaidCell("Yes")).toEqual({ kind: "paid_full", paidDate: null });
    expect(parsePaidCell("yes")).toEqual({ kind: "paid_full", paidDate: null });
  });

  it("NA → reject", () => {
    expect(parsePaidCell("NA")).toEqual({ kind: "reject" });
    expect(parsePaidCell("na")).toEqual({ kind: "reject" });
  });

  it("date alone → paid_full with that date", () => {
    expect(parsePaidCell("30 Jan 25")).toEqual({ kind: "paid_full", paidDate: "2025-01-30" });
    expect(parsePaidCell("1/30/2026")).toEqual({ kind: "paid_full", paidDate: "2026-01-30" });
  });

  it("date + 50% suffix → paid_half with that date", () => {
    expect(parsePaidCell("30 Jul 25 50%")).toEqual({ kind: "paid_half", paidDate: "2025-07-30" });
    expect(parsePaidCell("29 Sep 25 50%")).toEqual({ kind: "paid_half", paidDate: "2025-09-29" });
    expect(parsePaidCell("26 Feb 26 50%")).toEqual({ kind: "paid_half", paidDate: "2026-02-26" });
  });

  it("empty / null / unparseable → skip", () => {
    expect(parsePaidCell("")).toEqual({ kind: "skip" });
    expect(parsePaidCell(null)).toEqual({ kind: "skip" });
    expect(parsePaidCell(undefined)).toEqual({ kind: "skip" });
    expect(parsePaidCell("TBD")).toEqual({ kind: "skip" });
    expect(parsePaidCell("32 Jan 26")).toEqual({ kind: "skip" }); // invalid day
    expect(parsePaidCell("30 Xyz 26")).toEqual({ kind: "skip" }); // invalid month
  });
});

describe("parseMarketerTab", () => {
  // Schema A: Craig2/Raul2 — Note + Editor cols before tier cols
  const craig2Grid = [
    ["Ad No.", "Ad Name", "Link", "Note", "Editor", "13K Bonus", "65K Bonus", "Total Spend"],
    ["61", "", "", "", "", "", "", "$18"],
    ["1616", "DN Batch 20", "https://fb/x", "", "Craig", "30 Jan 26", "30 Mar 26", "$10000"],
    ["1731", "DN Batch 22", "https://fb/y", "", "Craig", "30 Apr 26", "", "$6000"],
  ];

  it("finds tier1/tier2 columns dynamically for Craig2-style header", () => {
    const r = parseMarketerTab({ marketer: "Craig", tab: "Craig2", grid: craig2Grid });
    expect(r.awards).toEqual([
      { marketer: "Craig", adNumber: "1616", tier: "tier1", approval: "approved_full", paidDate: "2026-01-30" },
      { marketer: "Craig", adNumber: "1616", tier: "tier2", approval: "approved_full", paidDate: "2026-03-30" },
      { marketer: "Craig", adNumber: "1731", tier: "tier1", approval: "approved_full", paidDate: "2026-04-30" },
    ]);
  });

  // Schema B: Jacob/Dan/JW/Tyler — no Editor col, 13K at idx 4
  const jacobGrid = [
    ["Ad No.", "Ad Name", "Link", "Note", "13K Bonus", "65K Bonus", "Total Spend"],
    ["1896", "", "", "", "30 Feb 26", "", "$8456"],
    ["1897", "", "", "", "", "", "$433"],
    ["1900", "", "", "", "15 Mar 26", "20 Apr 26", "$2786"],
  ];

  it("finds tier1/tier2 columns dynamically for Jacob-style header", () => {
    const r = parseMarketerTab({ marketer: "Jacob", tab: "Jacob", grid: jacobGrid });
    expect(r.awards.find((a) => a.adNumber === "1900" && a.tier === "tier1")?.paidDate).toBe("2026-03-15");
    expect(r.awards.find((a) => a.adNumber === "1900" && a.tier === "tier2")?.paidDate).toBe("2026-04-20");
  });

  it("filters out ads below Jacob's floor (1896)", () => {
    const grid = [
      ["Ad No.", "Ad Name", "Link", "Note", "13K Bonus", "65K Bonus", "Total Spend"],
      ["1500", "", "", "", "1 Mar 26", "", "$10000"], // below floor
      ["1896", "", "", "", "1 Mar 26", "", "$10000"], // at floor → included
      ["1900", "", "", "", "1 Mar 26", "", "$10000"], // above floor
    ];
    const r = parseMarketerTab({ marketer: "Jacob", tab: "Jacob", grid });
    expect(r.awards.map((a) => a.adNumber)).toEqual(["1896", "1900"]);
    expect(r.skipped.find((s) => s.adNumber === "1500")?.reason).toContain("below floor");
  });

  it("flags non-numeric ad numbers as skipped", () => {
    const grid = [
      ["Ad No.", "Ad Name", "Link", "Note", "13K Bonus", "65K Bonus", "Total Spend"],
      ["abc", "", "", "", "1 Mar 26", "", ""],
    ];
    const r = parseMarketerTab({ marketer: "Jacob", tab: "Jacob", grid });
    expect(r.awards).toEqual([]);
    expect(r.skipped[0].reason).toContain("non-numeric");
  });

  it("reports unparseable date cells without emitting an award", () => {
    const grid = [
      ["Ad No.", "Ad Name", "Link", "Note", "13K Bonus", "65K Bonus", "Total Spend"],
      ["1900", "", "", "", "TBD", "", "$10000"],
    ];
    const r = parseMarketerTab({ marketer: "Jacob", tab: "Jacob", grid });
    expect(r.awards).toEqual([]);
    expect(r.skipped.find((s) => s.adNumber === "1900")?.reason).toContain(
      "unparseable tier1",
    );
  });

  // Post-2026-05-28 cells:
  it("emits paid_full from 'Yes' flag cells", () => {
    const grid = [
      ["Ad No.", "Ad Name", "Link", "Note", "13K Bonus", "65K Bonus", "Total Spend"],
      ["1900", "", "", "", "Yes", "Yes", "$10000"],
    ];
    const r = parseMarketerTab({ marketer: "Jacob", tab: "Jacob", grid });
    expect(r.awards).toEqual([
      { marketer: "Jacob", adNumber: "1900", tier: "tier1", approval: "approved_full", paidDate: null },
      { marketer: "Jacob", adNumber: "1900", tier: "tier2", approval: "approved_full", paidDate: null },
    ]);
  });

  it("emits approved_half from 'X 50%' cells", () => {
    const grid = [
      ["Ad No.", "Ad Name", "Link", "Note", "13K Bonus", "65K Bonus", "Total Spend"],
      ["1900", "", "", "", "30 Jul 25 50%", "30 Jul 25 50%", "$10000"],
    ];
    const r = parseMarketerTab({ marketer: "Jacob", tab: "Jacob", grid });
    expect(r.awards).toEqual([
      { marketer: "Jacob", adNumber: "1900", tier: "tier1", approval: "approved_half", paidDate: "2025-07-30" },
      { marketer: "Jacob", adNumber: "1900", tier: "tier2", approval: "approved_half", paidDate: "2025-07-30" },
    ]);
  });

  it("emits rejected from 'NA' cells", () => {
    const grid = [
      ["Ad No.", "Ad Name", "Link", "Note", "13K Bonus", "65K Bonus", "Total Spend"],
      ["1900", "", "", "", "NA", "NA", "$10000"],
    ];
    const r = parseMarketerTab({ marketer: "Jacob", tab: "Jacob", grid });
    expect(r.awards).toEqual([
      { marketer: "Jacob", adNumber: "1900", tier: "tier1", approval: "rejected", paidDate: null },
      { marketer: "Jacob", adNumber: "1900", tier: "tier2", approval: "rejected", paidDate: null },
    ]);
  });

  it("mixes verdicts on the same row (tier1 paid full, tier2 50% half)", () => {
    const grid = [
      ["Ad No.", "Ad Name", "Link", "Note", "13K Bonus", "65K Bonus", "Total Spend"],
      ["1900", "", "", "", "30 Jun 25", "30 Jul 25 50%", "$80000"],
    ];
    const r = parseMarketerTab({ marketer: "Jacob", tab: "Jacob", grid });
    expect(r.awards).toEqual([
      { marketer: "Jacob", adNumber: "1900", tier: "tier1", approval: "approved_full", paidDate: "2025-06-30" },
      { marketer: "Jacob", adNumber: "1900", tier: "tier2", approval: "approved_half", paidDate: "2025-07-30" },
    ]);
  });

  it("errors clearly when tier headers are missing", () => {
    const grid = [
      ["Ad No.", "Ad Name", "Foo", "Bar"],
      ["1900", "", "", ""],
    ];
    const r = parseMarketerTab({ marketer: "Jacob", tab: "Jacob", grid });
    expect(r.awards).toEqual([]);
    expect(r.skipped[0].reason).toContain("missing tier headers");
  });

  it("treats 'J Weston' marketer name correctly (JW canonical)", () => {
    const grid = [
      ["Ad No.", "Ad Name", "Link", "Note", "13K Bonus", "65K Bonus", "Total Spend"],
      ["1907", "", "", "", "30 Mar 26", "", "$10000"],
    ];
    const r = parseMarketerTab({ marketer: "JW", tab: "J Weston", grid });
    expect(r.awards).toEqual([
      { marketer: "JW", adNumber: "1907", tier: "tier1", approval: "approved_full", paidDate: "2026-03-30" },
    ]);
  });
});

describe("parseSummaryTab", () => {
  // Mirrors the real "Summary" tab layout
  const summary = [
    ["Month", "Type", "Craig", "Raul", "Tyler", "Jacob", "J Weston", "Dan"],
    ["Feb 2026", "13K Bonus"],
    ["", "13K 50% Bonus"],
    ["", "65K Bonus", "2", "1"],
    ["", "65K 50% Bonus", "1", "1"],
    ["Mar 2026", "13K Bonus", "6", "1", "", "1", "", "1"],
    ["", "13K 50% Bonus", "3"],
    ["", "65K Bonus", "2", "1"],
  ];

  it("carries the month label forward into blank-month rows", () => {
    const out = parseSummaryTab(summary);
    const craigFeb65 = out.find(
      (s) => s.month === "Feb 2026" && s.marketer === "Craig" && s.tier === "tier2",
    );
    expect(craigFeb65).toEqual({
      month: "Feb 2026",
      marketer: "Craig",
      tier: "tier2",
      fullCount: 2,
      halfCount: 1,
    });
  });

  it("aggregates 13K Bonus and 13K 50% Bonus into one tier1 bucket", () => {
    const out = parseSummaryTab(summary);
    const craigMar13 = out.find(
      (s) => s.month === "Mar 2026" && s.marketer === "Craig" && s.tier === "tier1",
    );
    expect(craigMar13).toEqual({
      month: "Mar 2026",
      marketer: "Craig",
      tier: "tier1",
      fullCount: 6,
      halfCount: 3,
    });
  });

  it("maps the 'J Weston' header column to the JW canonical name", () => {
    const grid = [
      ["Month", "Type", "Craig", "Raul", "Tyler", "Jacob", "J Weston", "Dan"],
      ["Mar 2026", "13K Bonus", "", "", "", "", "2", ""],
    ];
    const out = parseSummaryTab(grid);
    expect(out).toEqual([
      { month: "Mar 2026", marketer: "JW", tier: "tier1", fullCount: 2, halfCount: 0 },
    ]);
  });
});

describe("detectHalfBonusMismatches", () => {
  it("flags ads requiring approved_half flip when summary shows halves", () => {
    const awards = [
      { marketer: "Craig" as const, adNumber: "1", tier: "tier2" as const, approval: "approved_full" as const, paidDate: "2026-02-15" },
      { marketer: "Craig" as const, adNumber: "2", tier: "tier2" as const, approval: "approved_full" as const, paidDate: "2026-02-20" },
      { marketer: "Craig" as const, adNumber: "3", tier: "tier2" as const, approval: "approved_full" as const, paidDate: "2026-02-25" },
    ];
    const summary = [
      { month: "Feb 2026", marketer: "Craig" as const, tier: "tier2" as const, fullCount: 2, halfCount: 1 },
    ];
    const out = detectHalfBonusMismatches({ awards, summary });
    expect(out).toEqual([
      {
        month: "Feb 2026",
        marketer: "Craig",
        tier: "tier2",
        inTabs: 3,
        summaryFull: 2,
        summaryHalf: 1,
        note: "1 of these 3 need flipping to approved_half",
      },
    ]);
  });

  it("flags count mismatches separately from half-flag advice", () => {
    const awards = [
      { marketer: "Dan" as const, adNumber: "1", tier: "tier1" as const, approval: "approved_full" as const, paidDate: "2026-03-10" },
    ];
    const summary = [
      { month: "Mar 2026", marketer: "Dan" as const, tier: "tier1" as const, fullCount: 3, halfCount: 0 },
    ];
    const out = detectHalfBonusMismatches({ awards, summary });
    expect(out[0].note).toContain("count mismatch");
  });

  it("flags summary buckets with no per-marketer-tab support", () => {
    const summary = [
      { month: "Jan 2026", marketer: "Raul" as const, tier: "tier1" as const, fullCount: 1, halfCount: 0 },
    ];
    const out = detectHalfBonusMismatches({ awards: [], summary });
    expect(out[0].note).toContain("summary has rows but per-marketer tab has none");
  });

  it("returns [] when tabs and summary perfectly agree (all full)", () => {
    const awards = [
      { marketer: "Tyler" as const, adNumber: "1", tier: "tier1" as const, approval: "approved_full" as const, paidDate: "2026-03-10" },
      { marketer: "Tyler" as const, adNumber: "2", tier: "tier1" as const, approval: "approved_full" as const, paidDate: "2026-03-12" },
    ];
    const summary = [
      { month: "Mar 2026", marketer: "Tyler" as const, tier: "tier1" as const, fullCount: 2, halfCount: 0 },
    ];
    expect(detectHalfBonusMismatches({ awards, summary })).toEqual([]);
  });
});
