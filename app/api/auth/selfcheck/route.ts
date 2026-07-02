// Protected no-op used by the health system's auth round-trip check. A
// freshly signed session cookie is fetched against this route so the request
// crosses the real Node-sign → Edge-middleware-verify boundary (the exact
// path that broke on 2026-07-01). The handler itself must stay trivial: no
// DB, no external calls — reaching it at all IS the check. This path must
// NOT be added to the middleware PUBLIC_PATHS list; being gated is the point.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true });
}
