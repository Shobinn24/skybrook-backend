import { describe, expect, it } from "vitest";
import {
  detectFbSheetShapeIssues,
  evaluateFbSheetShape,
} from "@/lib/jobs/fb-sheet-shape-check";

// Build a FB Ads Live-style grid: row 0 = ["Ad name","Link...",...dates],
// data rows = [name, link, ...costs aligned to the date columns].
function grid(
  dates: string[],
  rows: Array<{ name: string; link?: string; costs: Array<number | ""> }>,
): unknown[][] {
  const header = ["Ad name", "Link to promoted post", ...dates];
  const body = rows.map((r) => [r.name, r.link ?? "", ...r.costs]);
  return [header, ...body];
}

describe("detectFbSheetShapeIssues", () => {
  it("clean, contiguous, in-order sheet → no issues", () => {
    const g = grid(
      ["2026-06-11", "2026-06-12", "2026-06-13"],
      [
        { name: "(9055 CC) Ad 1 - x", costs: [10, 20, 30] },
        { name: "(HW CC) Ad 2 - y", costs: ["", 5, 0] },
      ],
    );
    const issues = detectFbSheetShapeIssues(g);
    expect(issues.outOfOrder).toEqual([]);
    expect(issues.emptyCols).toEqual([]);
  });

  it("flags an out-of-order date header", () => {
    const g = grid(
      ["2026-06-11", "2026-06-13", "2026-06-12"], // 06-12 < 06-13 → break
      [{ name: "(9055 CC) Ad 1 - x", costs: [10, 20, 30] }],
    );
    const issues = detectFbSheetShapeIssues(g);
    expect(issues.outOfOrder.map((c) => c.date)).toEqual(["2026-06-12"]);
    expect(issues.emptyCols).toEqual([]);
  });

  it("flags a present-but-empty (orphan) date column", () => {
    const g = grid(
      ["2026-06-11", "2026-06-12", "2026-06-13"],
      [
        { name: "(9055 CC) Ad 1 - x", costs: [10, 20, 0] }, // 06-13 all zero/blank
        { name: "(HW CC) Ad 2 - y", costs: [5, 5, ""] },
      ],
    );
    const issues = detectFbSheetShapeIssues(g);
    expect(issues.outOfOrder).toEqual([]);
    expect(issues.emptyCols.map((c) => c.date)).toEqual(["2026-06-13"]);
  });
});

describe("evaluateFbSheetShape", () => {
  it("clean grid → a single passing check (auto-resolves)", async () => {
    const g = grid(
      ["2026-06-11", "2026-06-12"],
      [{ name: "(9055 CC) Ad 1 - x", costs: [10, 20] }],
    );
    const checks = await evaluateFbSheetShape({ grid: g });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("pass");
    expect(checks[0].dedupKey).toBe("fb_sheet_shape");
    expect(checks[0].severity).toBe("p2");
  });

  it("orphan + out-of-order grid → a single failing check naming the columns", async () => {
    const g = grid(
      ["2026-06-11", "2026-06-13", "2026-06-12"],
      [{ name: "(9055 CC) Ad 1 - x", costs: [10, 5, 0] }], // 06-12 empty + out of order
    );
    const checks = await evaluateFbSheetShape({ grid: g });
    expect(checks).toHaveLength(1);
    const c = checks[0];
    expect(c.status).toBe("fail");
    expect(c.dedupKey).toBe("fb_sheet_shape");
    expect(String(c.fields.emptyCols)).toContain("2026-06-12");
    expect(String(c.fields.outOfOrderCols)).toContain("2026-06-12");
  });

  it("no grid available (missing env / fetch skipped) → no check, never throws", async () => {
    const checks = await evaluateFbSheetShape({ grid: null });
    expect(checks).toEqual([]);
  });
});
