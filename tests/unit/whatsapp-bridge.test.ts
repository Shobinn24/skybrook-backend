import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendViaWhatsAppBridge } from "@/lib/notifications/whatsapp-bridge";

describe("sendViaWhatsAppBridge", () => {
  beforeEach(() => {
    process.env.WHATSAPP_BRIDGE_URL = "https://bridge.example";
    process.env.WHATSAPP_BRIDGE_SECRET = "s3cret";
    process.env.BONUS_NOTIFICATION_CHAT_JID = "120@g.us";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WHATSAPP_BRIDGE_URL;
    delete process.env.WHATSAPP_BRIDGE_SECRET;
    delete process.env.BONUS_NOTIFICATION_CHAT_JID;
  });

  it("posts to the bridge with secret + chat jid and returns ok on 2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const res = await sendViaWhatsAppBridge("hello");
    expect(res).toEqual({ ok: true });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bridge.example/api/send");
    expect((opts.headers as Record<string, string>)["X-Bridge-Secret"]).toBe("s3cret");
    expect(JSON.parse(opts.body)).toEqual({ recipient: "120@g.us", message: "hello" });
  });

  it("returns ok:false with reason on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }),
    );
    expect(await sendViaWhatsAppBridge("x")).toEqual({ ok: false, reason: "bridge HTTP 500: boom" });
  });

  it("returns ok:false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("econn")));
    expect(await sendViaWhatsAppBridge("x")).toEqual({ ok: false, reason: "econn" });
  });

  it("returns ok:false when env is not configured", async () => {
    delete process.env.WHATSAPP_BRIDGE_URL;
    expect(await sendViaWhatsAppBridge("x")).toEqual({ ok: false, reason: "bridge not configured" });
  });
});
