import { describe, expect, it } from "vitest";
import { formatDigest, gatherOpsDigest, type DigestItem } from "@/lib/jobs/ops-digest";

describe("formatDigest", () => {
  it("headline counts attention items and lines carry the right marker", () => {
    const items: DigestItem[] = [
      { label: "A", ok: true, detail: "fine" },
      { label: "B", ok: false, detail: "broken" },
      { label: "C", ok: false, detail: "also broken" },
    ];
    const text = formatDigest("2026-07-14", items);
    expect(text).toContain("2 items need attention");
    expect(text).toContain("✅ *A*: fine");
    expect(text).toContain("⚠️ *B*: broken");
  });

  it("all green headline", () => {
    const text = formatDigest("2026-07-14", [{ label: "A", ok: true, detail: "fine" }]);
    expect(text).toContain("all checks green");
  });
});

describe("gatherOpsDigest", () => {
  it("runs every check against the test DB without throwing", async () => {
    const items = await gatherOpsDigest(new Date("2026-07-14T09:00:00Z"));
    const labels = items.map((i) => i.label);
    expect(labels).toEqual([
      "Phantom bonus crossings",
      "SKUs missing unit cost",
      "Schema drift",
      "Data pulls",
      "FB history frozen",
      "Bonus awards",
      "Launches SKU leak",
      "Unreceipted arrivals",
      "Open alerts",
      "Supermetrics queries",
    ]);
    // Every check produced a detail string; "check errored" means a query
    // is broken against the live schema, which is exactly what this guards.
    for (const i of items) {
      expect(i.detail.length).toBeGreaterThan(0);
      expect(i.detail).not.toContain("check errored");
    }
  });
});
