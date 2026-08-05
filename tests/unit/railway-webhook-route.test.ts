import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/hooks/railway-deploy/route";

// Route-level gate tests. Alerting is suppressed in the test env
// (tests/setup.ts clobbers the Slack webhooks), so postAlert/resolveAlert
// return early and these run with no DB.

function req(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const FAILED = {
  type: "DEPLOY",
  status: "FAILED",
  project: { name: "Skybrook Backend" },
  environment: { name: "production" },
  service: { name: "skybrook-cron-poll" },
};

describe("POST /api/hooks/railway-deploy", () => {
  afterEach(() => {
    delete process.env.RAILWAY_WEBHOOK_SECRET;
  });

  it("404s without the secret, with a wrong secret, and when unconfigured", async () => {
    process.env.RAILWAY_WEBHOOK_SECRET = "right-secret";
    expect((await POST(req("http://x/api/hooks/railway-deploy", FAILED))).status).toBe(404);
    expect(
      (await POST(req("http://x/api/hooks/railway-deploy?secret=wrong", FAILED))).status,
    ).toBe(404);

    // Unconfigured: fail closed even if the caller supplies something.
    delete process.env.RAILWAY_WEBHOOK_SECRET;
    expect(
      (await POST(req("http://x/api/hooks/railway-deploy?secret=anything", FAILED))).status,
    ).toBe(404);
  });

  it("handles a FAILED deploy with the right secret", async () => {
    process.env.RAILWAY_WEBHOOK_SECRET = "right-secret";
    const res = await POST(req("http://x/api/hooks/railway-deploy?secret=right-secret", FAILED));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handled).toBe("failure");
  });

  it("handles a SUCCESS deploy as a resolve", async () => {
    process.env.RAILWAY_WEBHOOK_SECRET = "right-secret";
    const res = await POST(
      req("http://x/api/hooks/railway-deploy?secret=right-secret", { ...FAILED, status: "SUCCESS" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).handled).toBe("success");
  });

  it("ignores transition statuses without touching alerting", async () => {
    process.env.RAILWAY_WEBHOOK_SECRET = "right-secret";
    const res = await POST(
      req("http://x/api/hooks/railway-deploy?secret=right-secret", { ...FAILED, status: "BUILDING" }),
    );
    expect((await res.json()).handled).toBe("ignored");
  });

  it("400s on malformed JSON instead of throwing", async () => {
    process.env.RAILWAY_WEBHOOK_SECRET = "right-secret";
    const res = await POST(req("http://x/api/hooks/railway-deploy?secret=right-secret", "{not json"));
    expect(res.status).toBe(400);
  });
});
