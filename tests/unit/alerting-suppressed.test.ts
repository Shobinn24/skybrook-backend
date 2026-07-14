import { afterEach, describe, expect, it } from "vitest";
import { alertingSuppressed } from "@/lib/notifications/slack";

// The dev guard that keeps local sessions from paging real Slack or
// writing alert_events into prod. NODE_ENV is 'test' under vitest, so the
// suite itself is never suppressed; these tests poke the two dev signals.

const ORIG = { ...process.env };

afterEach(() => {
  process.env.SKYBROOK_DEV_BYPASS = ORIG.SKYBROOK_DEV_BYPASS ?? "";
  process.env.SKYBROOK_ALERTS_FORCE = ORIG.SKYBROOK_ALERTS_FORCE ?? "";
  delete process.env.SKYBROOK_DEV_BYPASS;
  delete process.env.SKYBROOK_ALERTS_FORCE;
});

describe("alertingSuppressed", () => {
  it("is off under the test runner (setup.ts blanks webhooks instead)", () => {
    expect(alertingSuppressed()).toBe(false);
  });

  it("suppresses when the dev bypass is on", () => {
    process.env.SKYBROOK_DEV_BYPASS = "1";
    expect(alertingSuppressed()).toBe(true);
  });

  it("force flag re-enables real alerting from dev", () => {
    process.env.SKYBROOK_DEV_BYPASS = "1";
    process.env.SKYBROOK_ALERTS_FORCE = "1";
    expect(alertingSuppressed()).toBe(false);
  });
});
