import { describe, expect, it } from "vitest";
import { detectAutoReceipts, selectSnapshotWindow, type WindowRow } from "@/lib/domain/auto-receipt";

const PO_BASE = {
  shipmentName: "KAI Mens Apr26",
  expectedArrival: "2026-04-30",
};

describe("detectAutoReceipts", () => {
  it("matches a single overdue PO when stock jumps by ~its quantity", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].shipmentName).toBe("KAI Mens Apr26");
    expect(out[0].detectedDelta).toBe(200);
    expect(out[0].poQuantity).toBe(200);
  });

  it("adds same-day sales back into delta so a partially-sold delivery still matches", () => {
    // Stock 50 → 220 looks like +170. But 30 sold today → adjusted = 200.
    // PO was 200 — should match.
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 220 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [{ sku: "ev-mens-l", location: "US", units: 30 }],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].reasoning).toContain("+30 sold same day");
  });

  it("ignores stock decreases (sales-only days don't fire)", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 30 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("ignores tiny jumps (counting tweaks below MIN_ABSOLUTE_DELTA)", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 55 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 10, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("skips when no overdue PO matches the delta (likely manual correction)", () => {
    // Stock jumped 200 but the only overdue PO is for 1000 — way out of band.
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 1000, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("skips when multiple POs match (ambiguous — operator picks)", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [
        { sku: "ev-mens-l", destination: "US", quantity: 200, shipmentName: "PO-A", expectedArrival: "2026-04-15" },
        { sku: "ev-mens-l", destination: "US", quantity: 180, shipmentName: "PO-B", expectedArrival: "2026-04-20" },
      ],
    });
    expect(out).toEqual([]);
  });

  it("skips when no yesterday snapshot exists for the SKU", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("does not cross-match across destinations (US delta won't match a CN PO)", () => {
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "CN", quantity: 200, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("respects upper tolerance — a 200 delta ignoring a 100-unit PO", () => {
    // 200 / 100 = 2.0, well above MAX_MULTIPLIER (1.3). No match.
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 250 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 100, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("respects lower tolerance — partial delivery half the PO size doesn't match", () => {
    // PO 200, only +80 stock change. 80/200 = 0.4, below MIN_MULTIPLIER (0.7).
    // Treat as partial / Scott confirms manually.
    const out = detectAutoReceipts({
      todaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 130 }],
      yesterdaySnapshots: [{ sku: "ev-mens-l", location: "US", onHand: 50 }],
      todaySales: [],
      overduePOs: [{ sku: "ev-mens-l", destination: "US", quantity: 200, ...PO_BASE }],
    });
    expect(out).toEqual([]);
  });

  it("matches multiple SKUs of the same shipment as separate detection rows", () => {
    // A real shipment lands across many SKU rows; the detector emits
    // one match per SKU. The job-level de-duplication collapses them
    // to one receipt (covered by integration test).
    const out = detectAutoReceipts({
      todaySnapshots: [
        { sku: "ev-mens-s", location: "US", onHand: 100 },
        { sku: "ev-mens-m", location: "US", onHand: 150 },
      ],
      yesterdaySnapshots: [
        { sku: "ev-mens-s", location: "US", onHand: 0 },
        { sku: "ev-mens-m", location: "US", onHand: 50 },
      ],
      todaySales: [],
      overduePOs: [
        { sku: "ev-mens-s", destination: "US", quantity: 100, shipmentName: "KAI Mens Apr26", expectedArrival: "2026-04-30" },
        { sku: "ev-mens-m", destination: "US", quantity: 100, shipmentName: "KAI Mens Apr26", expectedArrival: "2026-04-30" },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.shipmentName === "KAI Mens Apr26")).toBe(true);
  });

  describe("pass 2 — shipment-level aggregate matching", () => {
    // Scott 2026-05-06 round 2: per-SKU matching can miss when SKUs
    // come in below/above the 0.7-1.3× tolerance individually but the
    // shipment-wide sum lands on target.

    it("matches a partial delivery via aggregate when no SKU passes per-SKU band", () => {
      // PO 100u/SKU × 4 SKUs = 400u total. Real arrival: 60+70+80+90 = 300.
      // Per-SKU ratios: 0.6, 0.7, 0.8, 0.9 — three within band per SKU,
      // but the shipment is unmatched after pass 1 because each SKU only
      // appears on this shipment so pass 1 would actually match three of
      // them. To isolate pass 2, pick ratios that ALL fall outside
      // per-SKU tolerance (e.g., 0.5 each) so pass 1 fires for none.
      const out = detectAutoReceipts({
        todaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 50 },
          { sku: "ev-bshort-m", location: "CN", onHand: 50 },
          { sku: "ev-bshort-l", location: "CN", onHand: 50 },
          { sku: "ev-bshort-xl", location: "CN", onHand: 50 },
        ],
        yesterdaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 0 },
          { sku: "ev-bshort-m", location: "CN", onHand: 0 },
          { sku: "ev-bshort-l", location: "CN", onHand: 0 },
          { sku: "ev-bshort-xl", location: "CN", onHand: 0 },
        ],
        todaySales: [],
        // PO 100/SKU. Each individual ratio is 50/100 = 0.5, below 0.7
        // per-SKU min. Aggregate 200/400 = 0.5 — also below band.
        // Move thresholds: deliver 80/SKU instead → 320/400 = 0.8.
        overduePOs: [
          { sku: "ev-bshort-s", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-m", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-l", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-xl", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
        ],
      });
      // 0.5 ratio is below per-SKU band AND below aggregate band → no match.
      expect(out).toEqual([]);
    });

    it("matches via aggregate when individual SKUs vary but the sum lands in band", () => {
      // PO 200/SKU × 4 = 800u. Reality: 100, 180, 220, 280 — individual
      // ratios 0.5, 0.9, 1.1, 1.4 (one above 1.3, one below 0.7). Pass 1
      // matches the 0.9 and 1.1 cases, taking the shipment.
      // To isolate pass 2: make each SKU's ratio fall outside per-SKU
      // band so pass 1 doesn't fire. e.g., individual ratios all 0.6
      // (under 0.7) but aggregate 0.6 too — won't match.
      // Better: 0.6, 0.6, 1.4, 1.4 — none in per-SKU band, aggregate
      // (0.6+0.6+1.4+1.4)/4 = 1.0 → matches.
      const out = detectAutoReceipts({
        todaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 60 },
          { sku: "ev-bshort-m", location: "CN", onHand: 60 },
          { sku: "ev-bshort-l", location: "CN", onHand: 140 },
          { sku: "ev-bshort-xl", location: "CN", onHand: 140 },
        ],
        yesterdaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 0 },
          { sku: "ev-bshort-m", location: "CN", onHand: 0 },
          { sku: "ev-bshort-l", location: "CN", onHand: 0 },
          { sku: "ev-bshort-xl", location: "CN", onHand: 0 },
        ],
        todaySales: [],
        overduePOs: [
          { sku: "ev-bshort-s", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-m", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-l", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-xl", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
        ],
      });
      expect(out).toHaveLength(1);
      expect(out[0].shipmentName).toBe("KAI Bshort PO");
      expect(out[0].reasoning).toContain("Aggregate stock jump");
    });

    it("does NOT aggregate-match when SKUs overlap with another overdue shipment", () => {
      // Shipment A and B both have ev-bshort-s + ev-bshort-m at CN.
      // No exclusive coverage → pass 2 skips both.
      const out = detectAutoReceipts({
        todaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 100 },
          { sku: "ev-bshort-m", location: "CN", onHand: 100 },
        ],
        yesterdaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 0 },
          { sku: "ev-bshort-m", location: "CN", onHand: 0 },
        ],
        todaySales: [],
        overduePOs: [
          // Shipment A
          { sku: "ev-bshort-s", destination: "CN", quantity: 100, shipmentName: "KAI Bshort A", expectedArrival: "2026-04-15" },
          { sku: "ev-bshort-m", destination: "CN", quantity: 100, shipmentName: "KAI Bshort A", expectedArrival: "2026-04-15" },
          // Shipment B (overlaps A)
          { sku: "ev-bshort-s", destination: "CN", quantity: 100, shipmentName: "KAI Bshort B", expectedArrival: "2026-04-25" },
          { sku: "ev-bshort-m", destination: "CN", quantity: 100, shipmentName: "KAI Bshort B", expectedArrival: "2026-04-25" },
        ],
      });
      // Pass 1: each SKU has 2 candidates → ambiguous → skip.
      // Pass 2: zero exclusive SKUs in either shipment → both skip.
      expect(out).toEqual([]);
    });

    it("requires at least 2 SKUs to have positively jumped before aggregate-matching", () => {
      // 4-SKU shipment but only 1 SKU jumped — that's pass-1 territory,
      // not pass 2. Aggregate match should NOT fire.
      const out = detectAutoReceipts({
        todaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 600 }, // huge jump
          { sku: "ev-bshort-m", location: "CN", onHand: 0 },   // no movement
          { sku: "ev-bshort-l", location: "CN", onHand: 0 },
          { sku: "ev-bshort-xl", location: "CN", onHand: 0 },
        ],
        yesterdaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 0 },
          { sku: "ev-bshort-m", location: "CN", onHand: 0 },
          { sku: "ev-bshort-l", location: "CN", onHand: 0 },
          { sku: "ev-bshort-xl", location: "CN", onHand: 0 },
        ],
        todaySales: [],
        // PO 200/SKU × 4 = 800. Aggregate 600/800 = 0.75 — in band, but
        // only 1 SKU jumped. Pass 1 already found the match (600/200 = 3,
        // outside per-SKU band, no pass-1 hit). Pass 2 should skip
        // because <2 SKUs jumped.
        overduePOs: [
          { sku: "ev-bshort-s", destination: "CN", quantity: 200, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-m", destination: "CN", quantity: 200, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-l", destination: "CN", quantity: 200, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-xl", destination: "CN", quantity: 200, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
        ],
      });
      expect(out).toEqual([]);
    });

    it("aggregate match doesn't double-fire when pass 1 already matched the shipment", () => {
      // Pass 1 catches the clean SKU; pass 2 must skip the rest of the
      // shipment so we don't end up with duplicate receipt rows.
      const out = detectAutoReceipts({
        todaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 200 }, // clean +200
          { sku: "ev-bshort-m", location: "CN", onHand: 60 },  // partial
          { sku: "ev-bshort-l", location: "CN", onHand: 60 },
        ],
        yesterdaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 0 },
          { sku: "ev-bshort-m", location: "CN", onHand: 0 },
          { sku: "ev-bshort-l", location: "CN", onHand: 0 },
        ],
        todaySales: [],
        overduePOs: [
          { sku: "ev-bshort-s", destination: "CN", quantity: 200, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-m", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-l", destination: "CN", quantity: 100, shipmentName: "KAI Bshort PO", expectedArrival: "2026-04-30" },
        ],
      });
      // Pass 1 matches ev-bshort-s. Pass 2 should NOT also match.
      expect(out).toHaveLength(1);
      expect(out[0].reasoning).toContain("ev-bshort-s");
    });

    it("aggregate-skip tiny shipments (below the 50-unit floor)", () => {
      // Pick deltas under 20 each so pass-1's floor skips them, AND
      // total expected under 50 so pass 2's floor skips them too.
      const out = detectAutoReceipts({
        todaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 19 },
          { sku: "ev-bshort-m", location: "CN", onHand: 19 },
        ],
        yesterdaySnapshots: [
          { sku: "ev-bshort-s", location: "CN", onHand: 0 },
          { sku: "ev-bshort-m", location: "CN", onHand: 0 },
        ],
        todaySales: [],
        overduePOs: [
          { sku: "ev-bshort-s", destination: "CN", quantity: 20, shipmentName: "KAI Tiny PO", expectedArrival: "2026-04-30" },
          { sku: "ev-bshort-m", destination: "CN", quantity: 20, shipmentName: "KAI Tiny PO", expectedArrival: "2026-04-30" },
        ],
      });
      expect(out).toEqual([]);
    });
  });
});

describe("selectSnapshotWindow", () => {
  const rows = (xs: Array<[string, "US" | "CN", string, number]>): WindowRow[] =>
    xs.map(([sku, location, snapshotDate, onHand]) => ({ sku, location, snapshotDate, onHand }));

  it("pairs each location with its own latest two dates when both share the date", () => {
    const w = selectSnapshotWindow({
      asOfDate: "2026-05-29",
      rows: rows([
        ["ev-us", "US", "2026-05-29", 300],
        ["ev-us", "US", "2026-05-28", 100],
        ["ev-cn", "CN", "2026-05-29", 80],
        ["ev-cn", "CN", "2026-05-28", 50],
      ]),
    });
    expect(w.afterByLocation.get("US")).toBe("2026-05-29");
    expect(w.beforeByLocation.get("US")).toBe("2026-05-28");
    expect(w.afterByLocation.get("CN")).toBe("2026-05-29");
    expect(w.beforeByLocation.get("CN")).toBe("2026-05-28");
    expect(w.todaySnapshots).toContainEqual({ sku: "ev-us", location: "US", onHand: 300 });
    expect(w.yesterdaySnapshots).toContainEqual({ sku: "ev-cn", location: "CN", onHand: 50 });
  });

  it("region split: US newest is 06-01, CN newest is 05-31 — each pairs within its own region (the 2026-05-30 regression)", () => {
    // Real prod shape: US tabs advanced to 06-01, CN tabs still at 05-31.
    // 05-31 had NO US rows; 06-01 has NO CN rows. A global today/yesterday
    // would diff US@06-01 vs CN@05-31 and detect nothing.
    const w = selectSnapshotWindow({
      asOfDate: "2026-06-01",
      rows: rows([
        ["ev-hrshort", "US", "2026-06-01", 929],
        ["ev-hrshort", "US", "2026-05-30", 0], // US skipped 05-31
        ["ev-mens", "CN", "2026-05-31", 500],
        ["ev-mens", "CN", "2026-05-29", 100], // CN skipped 05-30
      ]),
    });
    expect(w.afterByLocation.get("US")).toBe("2026-06-01");
    expect(w.beforeByLocation.get("US")).toBe("2026-05-30"); // gap-resilient
    expect(w.afterByLocation.get("CN")).toBe("2026-05-31");
    expect(w.beforeByLocation.get("CN")).toBe("2026-05-29");
    expect(w.todaySnapshots).toEqual([
      { sku: "ev-hrshort", location: "US", onHand: 929 },
      { sku: "ev-mens", location: "CN", onHand: 500 },
    ]);
    expect(w.yesterdaySnapshots).toEqual([
      { sku: "ev-hrshort", location: "US", onHand: 0 },
      { sku: "ev-mens", location: "CN", onHand: 100 },
    ]);
  });

  it("feeds detectAutoReceipts so a split-day US arrival still matches its PO", () => {
    const w = selectSnapshotWindow({
      asOfDate: "2026-06-01",
      rows: rows([
        ["ev-hrshort-l", "US", "2026-06-01", 950],
        ["ev-hrshort-l", "US", "2026-05-30", 20],
        ["ev-mens-l", "CN", "2026-05-31", 500], // CN newest, unrelated
      ]),
    });
    const out = detectAutoReceipts({
      todaySnapshots: w.todaySnapshots,
      yesterdaySnapshots: w.yesterdaySnapshots,
      todaySales: [],
      overduePOs: [
        { sku: "ev-hrshort-l", destination: "US", quantity: 930, shipmentName: "KAI HRS Jun26", expectedArrival: "2026-05-29" },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].shipmentName).toBe("KAI HRS Jun26");
  });

  it("ignores snapshots dated after asOfDate and skips a location with only one date", () => {
    const w = selectSnapshotWindow({
      asOfDate: "2026-06-01",
      rows: rows([
        ["ev-us", "US", "2026-06-02", 999], // future — ignored
        ["ev-us", "US", "2026-06-01", 300],
        ["ev-cn", "CN", "2026-06-01", 80], // only one CN date → no "before"
      ]),
    });
    expect(w.afterByLocation.get("US")).toBe("2026-06-01");
    expect(w.beforeByLocation.has("CN")).toBe(false);
    expect(w.yesterdaySnapshots.some((s) => s.location === "CN")).toBe(false);
  });
});
