// Sends a message to the WhatsApp group via the cloud whatsmeow bridge.
// Returns {ok:false, reason} on any failure so callers record it as a
// resendable failed batch rather than throwing.

export async function sendViaWhatsAppBridge(
  body: string,
): Promise<{ ok: boolean; reason?: string }> {
  const url = process.env.WHATSAPP_BRIDGE_URL;
  const secret = process.env.WHATSAPP_BRIDGE_SECRET;
  const recipient = process.env.BONUS_NOTIFICATION_CHAT_JID;
  if (!url || !secret || !recipient) {
    return { ok: false, reason: "bridge not configured" };
  }
  try {
    const res = await fetch(`${url}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Secret": secret },
      body: JSON.stringify({ recipient, message: body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: `bridge HTTP ${res.status}: ${text}`.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
