import { describe, expect, it } from "vitest";
import { parseDeployEvent } from "@/lib/jobs/deploy-status";

// The 2026-08-04 incident this whole feature exists for: a FAILED build on
// one service while a sibling service succeeded from the same commit, with
// Railway silently keeping the old deployment running.

const LEGACY_FAILED = {
  type: "DEPLOY",
  status: "FAILED",
  project: { name: "Skybrook Backend" },
  environment: { name: "production" },
  service: { name: "skybrook-cron-poll" },
  deployment: { meta: { commitHash: "448017b9abcdef0123", commitMessage: "New-product launch detector" } },
};

const CURRENT_FAILED = {
  type: "Deployment.failed",
  details: { status: "FAILED", commitHash: "448017b9abcdef0123", commitMessage: "New-product launch detector" },
  resource: {
    project: { name: "Skybrook Backend" },
    environment: { name: "production" },
    service: { name: "skybrook-cron-poll" },
  },
  timestamp: "2026-08-04T14:05:43Z",
};

describe("parseDeployEvent", () => {
  it("fires on a legacy-shape FAILED deploy", () => {
    const e = parseDeployEvent(LEGACY_FAILED);
    expect(e.kind).toBe("failure");
    if (e.kind !== "failure") return;
    expect(e.service).toBe("skybrook-cron-poll");
    expect(e.dedupKey).toBe("deploy_status:skybrook_backend:skybrook_cron_poll");
    expect(e.title).toContain("still running the previous build");
    expect(e.fields.commit).toBe("448017b9abcd");
  });

  it("fires on a current-shape FAILED deploy (status inside details/resource)", () => {
    const e = parseDeployEvent(CURRENT_FAILED);
    expect(e.kind).toBe("failure");
    if (e.kind !== "failure") return;
    expect(e.service).toBe("skybrook-cron-poll");
    expect(e.dedupKey).toBe("deploy_status:skybrook_backend:skybrook_cron_poll");
  });

  it("derives the status from the event type when no status field exists", () => {
    const e = parseDeployEvent({
      type: "Deployment.failed",
      resource: { project: { name: "P" }, environment: { name: "production" }, service: { name: "S" } },
    });
    expect(e.kind).toBe("failure");
  });

  it("treats CRASHED like FAILED — a crash loop also leaves stale behavior", () => {
    const e = parseDeployEvent({ ...LEGACY_FAILED, status: "CRASHED" });
    expect(e.kind).toBe("failure");
  });

  it("maps SUCCESS to a resolve with the SAME dedup key as the failure", () => {
    const fail = parseDeployEvent(LEGACY_FAILED);
    const ok = parseDeployEvent({ ...LEGACY_FAILED, status: "SUCCESS" });
    expect(ok.kind).toBe("success");
    if (ok.kind !== "success" || fail.kind !== "failure") return;
    expect(ok.dedupKey).toBe(fail.dedupKey);
  });

  it("ignores transition statuses (BUILDING, DEPLOYING, QUEUED, REMOVED)", () => {
    for (const status of ["BUILDING", "DEPLOYING", "QUEUED", "REMOVED", "SKIPPED"]) {
      const e = parseDeployEvent({ ...LEGACY_FAILED, status });
      expect(e.kind, status).toBe("ignored");
    }
  });

  it("ignores non-production environments (PR/preview noise)", () => {
    const e = parseDeployEvent({
      ...LEGACY_FAILED,
      environment: { name: "pr-42" },
    });
    expect(e.kind).toBe("ignored");
  });

  it("still fires when the payload carries no environment at all", () => {
    const { environment: _dropped, ...noEnv } = LEGACY_FAILED;
    const e = parseDeployEvent(noEnv);
    expect(e.kind).toBe("failure");
  });

  it("ignores unparseable bodies rather than throwing", () => {
    for (const body of [null, undefined, "string", 42, [], {}]) {
      const e = parseDeployEvent(body);
      expect(e.kind).toBe("ignored");
    }
  });

  it("keys dedup by project AND service so sibling services alert independently", () => {
    const web = parseDeployEvent({ ...LEGACY_FAILED, service: { name: "skybrook-backend" } });
    const poll = parseDeployEvent(LEGACY_FAILED);
    if (web.kind !== "failure" || poll.kind !== "failure") throw new Error("expected failures");
    expect(web.dedupKey).not.toBe(poll.dedupKey);
  });
});

describe("Railway v2 event vocabulary (dashboard picker names)", () => {
  const base = {
    resource: {
      project: { name: "Skybrook Backend" },
      environment: { name: "production" },
      service: { name: "skybrook-cron-poll" },
    },
  };

  it("Deployment.oomKilled is a failure", () => {
    expect(parseDeployEvent({ ...base, type: "Deployment.oomKilled" }).kind).toBe("failure");
  });

  it("Deployment.deployed and Deployment.redeployed are successes", () => {
    expect(parseDeployEvent({ ...base, type: "Deployment.deployed" }).kind).toBe("success");
    expect(parseDeployEvent({ ...base, type: "Deployment.redeployed" }).kind).toBe("success");
  });

  it("DEPLOYED status resolves with the same key its FAILED fired under", () => {
    const fail = parseDeployEvent({ ...base, type: "Deployment.failed" });
    const ok = parseDeployEvent({ ...base, type: "Deployment.deployed" });
    if (fail.kind !== "failure" || ok.kind !== "success") throw new Error("bad kinds");
    expect(ok.dedupKey).toBe(fail.dedupKey);
  });

  it("unknown lifecycle types stay ignored (Deployment.building, Deployment.queued)", () => {
    expect(parseDeployEvent({ ...base, type: "Deployment.building" }).kind).toBe("ignored");
    expect(parseDeployEvent({ ...base, type: "Deployment.queued" }).kind).toBe("ignored");
  });
});
