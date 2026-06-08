import { describe, expect, it } from "vitest";
import { reconcileReceiptKeys } from "@/lib/sources/sheets";

// A current shipment key (name + destination + ETA as YYYY-MM-DD).
const s = (shipmentName: string, destination: string, expectedArrival: string) => ({
  shipmentName,
  destination,
  expectedArrival,
});
// A receipt row (carries an id + its recorded key).
const r = (id: string, shipmentName: string, destination: string, expectedArrival: string) => ({
  id,
  shipmentName,
  destination,
  expectedArrival,
});

describe("reconcileReceiptKeys", () => {
  it("does NOT re-key a receipt that exactly matches a current shipment", () => {
    expect(
      reconcileReceiptKeys([s("KAI", "US", "2026-06-04")], [r("r1", "KAI", "US", "2026-06-04")]),
    ).toEqual([]);
  });

  it("re-keys an orphaned receipt to a same-name/dest shipment whose ETA drifted 1 day", () => {
    expect(
      reconcileReceiptKeys([s("KAI", "US", "2026-06-04")], [r("r1", "KAI", "US", "2026-06-03")]),
    ).toEqual([{ id: "r1", newExpectedArrival: "2026-06-04" }]);
  });

  it("does NOT re-key when the nearest shipment is beyond the tolerance window", () => {
    expect(
      reconcileReceiptKeys([s("KAI", "US", "2026-06-20")], [r("r1", "KAI", "US", "2026-06-03")]),
    ).toEqual([]);
  });

  it("does NOT re-key onto an ETA that already has its own receipt (collision guard)", () => {
    // r1 exactly matches 06-04; r2 (orphan at 06-03) must not steal 06-04.
    expect(
      reconcileReceiptKeys(
        [s("KAI", "US", "2026-06-04")],
        [r("r1", "KAI", "US", "2026-06-04"), r("r2", "KAI", "US", "2026-06-03")],
      ),
    ).toEqual([]);
  });

  it("picks the nearest shipment ETA when several share name+destination", () => {
    expect(
      reconcileReceiptKeys(
        [s("KAI", "US", "2026-06-06"), s("KAI", "US", "2026-06-04")],
        [r("r1", "KAI", "US", "2026-06-03")],
      ),
    ).toEqual([{ id: "r1", newExpectedArrival: "2026-06-04" }]);
  });

  it("assigns one shipment to only one receipt when two orphans compete", () => {
    // r1 (06-03) and r2 (06-05) are both 1 day from the only shipment (06-04).
    // Deterministic: earliest receipt ETA wins the slot; the other stays put.
    expect(
      reconcileReceiptKeys(
        [s("KAI", "US", "2026-06-04")],
        [r("r1", "KAI", "US", "2026-06-03"), r("r2", "KAI", "US", "2026-06-05")],
      ),
    ).toEqual([{ id: "r1", newExpectedArrival: "2026-06-04" }]);
  });

  it("never matches across destinations", () => {
    expect(
      reconcileReceiptKeys([s("KAI", "CN", "2026-06-04")], [r("r1", "KAI", "US", "2026-06-03")]),
    ).toEqual([]);
  });
});
