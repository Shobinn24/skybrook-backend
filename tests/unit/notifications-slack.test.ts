import { describe, expect, it } from "vitest";
import { __internals__ } from "@/lib/notifications/slack";

const { buildBlocks, channelForSeverity } = __internals__;

describe("channelForSeverity", () => {
  it("routes p0 and p1 to alerts, p2 to digest, p3 to debug", () => {
    expect(channelForSeverity("p0")).toBe("alerts");
    expect(channelForSeverity("p1")).toBe("alerts");
    expect(channelForSeverity("p2")).toBe("digest");
    expect(channelForSeverity("p3")).toBe("debug");
  });
});

describe("buildBlocks", () => {
  const firedAt = new Date("2026-05-13T20:00:00Z");

  it("includes severity emoji + title in the header", () => {
    const out = buildBlocks(
      { severity: "p1", title: "shopify_intl ingest failed", dedupKey: "k1" },
      [],
      firedAt,
    );
    const header = out.blocks.find((b) => b.type === "header");
    expect(header).toBeDefined();
    if (header?.type === "header") {
      expect(header.text.text).toContain("P1");
      expect(header.text.text).toContain("shopify_intl ingest failed");
    }
  });

  it("prepends @mention into fallback text for P0", () => {
    const out = buildBlocks(
      { severity: "p0", title: "outage", dedupKey: "k1" },
      ["U0B37DUSLUX"],
      firedAt,
    );
    expect(out.text).toContain("<@U0B37DUSLUX>");
    expect(out.text).toContain("P0");
  });

  it("omits mention section when no user IDs supplied", () => {
    const out = buildBlocks(
      { severity: "p2", title: "minor", dedupKey: "k2" },
      [],
      firedAt,
    );
    expect(out.text).not.toContain("<@");
    const sectionWithMention = out.blocks.some(
      (b) => b.type === "section" && b.text?.text.includes("<@"),
    );
    expect(sectionWithMention).toBe(false);
  });

  it("emits one field block per field, chunked at 10", () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 23; i++) fields[`f${i}`] = `v${i}`;
    const out = buildBlocks(
      { severity: "p2", title: "drift", dedupKey: "k3", fields },
      [],
      firedAt,
    );
    const sectionBlocks = out.blocks.filter(
      (b) => b.type === "section" && b.fields !== undefined,
    );
    // 23 fields = 10 + 10 + 3 = 3 section blocks
    expect(sectionBlocks).toHaveLength(3);
  });

  it("skips null/undefined field values", () => {
    const out = buildBlocks(
      {
        severity: "p2",
        title: "drift",
        dedupKey: "k4",
        fields: { real: "yes", missing: null, alsoMissing: undefined },
      },
      [],
      firedAt,
    );
    const allFieldsText = out.blocks
      .filter((b) => b.type === "section" && b.fields)
      .flatMap((b) => (b.type === "section" ? b.fields ?? [] : []))
      .map((f) => f.text)
      .join("\n");
    expect(allFieldsText).toContain("real");
    expect(allFieldsText).not.toContain("missing");
  });

  it("truncates oversized field values to 500 chars", () => {
    const huge = "x".repeat(1000);
    const out = buildBlocks(
      { severity: "p1", title: "big", dedupKey: "k5", fields: { err: huge } },
      [],
      firedAt,
    );
    const allText = JSON.stringify(out);
    // Original 1000 x's should not be present
    expect(allText.includes("x".repeat(501))).toBe(false);
  });

  it("includes dedupKey in the context block for traceability", () => {
    const out = buildBlocks(
      { severity: "p1", title: "x", dedupKey: "freshness:daily_sales:shopify_intl" },
      [],
      firedAt,
    );
    const ctx = out.blocks.find((b) => b.type === "context");
    expect(ctx).toBeDefined();
    if (ctx?.type === "context") {
      expect(ctx.elements[0].text).toContain("freshness:daily_sales:shopify_intl");
    }
  });
});
