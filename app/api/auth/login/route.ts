import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, createSessionToken, timingSafeEqual } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const expected = process.env.APP_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!expected || !secret) {
    return NextResponse.json({ ok: false, error: "server not configured" }, { status: 500 });
  }

  let submitted = "";
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const body = (await req.json()) as { password?: string };
      submitted = body.password ?? "";
    } else {
      const form = await req.formData();
      submitted = String(form.get("password") ?? "");
    }
  } catch {
    submitted = "";
  }

  if (!submitted || !timingSafeEqual(submitted, expected)) {
    // Small delay to blunt brute force timing — still not rate-limited, acceptable for 4-user tool.
    await new Promise((r) => setTimeout(r, 250));
    const next = req.headers.get("x-next-path") ?? "/login?error=1";
    return ct.includes("application/json")
      ? NextResponse.json({ ok: false }, { status: 401 })
      : NextResponse.redirect(new URL(next, req.url));
  }

  const token = await createSessionToken(secret);
  const res = ct.includes("application/json")
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(new URL("/inventory", req.url));

  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
