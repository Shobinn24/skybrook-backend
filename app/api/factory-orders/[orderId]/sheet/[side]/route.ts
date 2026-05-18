/**
 * Stream the .xlsx for an approved factory order.
 *
 *   GET /api/factory-orders/<orderId>/sheet/<US|INTL>
 *
 * Spec: docs/factory-order-spec/factory-order-automation.md §8
 *
 * Generates on-demand from `factory_order_lines` so the file always
 * reflects the snapshot taken at approval time (not whatever the live
 * calc would produce right now). 404 when the order is missing,
 * 409 when it's still in draft state.
 */

import { NextResponse } from "next/server";

import { buildSheetBuffer } from "@/lib/jobs/factory-order-excel";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ orderId: string; side: string }> },
) {
  const params = await ctx.params;
  const side = params.side.toUpperCase();
  if (side !== "US" && side !== "INTL") {
    return NextResponse.json(
      { ok: false, error: `Unknown side: ${params.side}` },
      { status: 400 },
    );
  }

  try {
    const { buffer, filename } = await buildSheetBuffer({
      orderId: params.orderId,
      side: side as "US" | "INTL",
    });
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("factory-order.sheet.failed", {
      orderId: params.orderId,
      side,
      error: msg,
    });
    if (msg.includes("not found")) {
      return NextResponse.json({ ok: false, error: msg }, { status: 404 });
    }
    if (msg.includes("un-approved")) {
      return NextResponse.json({ ok: false, error: msg }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
