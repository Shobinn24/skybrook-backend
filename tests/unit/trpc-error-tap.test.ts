import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { reportTrpcError } from "@/lib/notifications/trpc-error-tap";

describe("reportTrpcError", () => {
  it("fires P1 with dedupKey trpc.error:<procedure> on INTERNAL_SERVER_ERROR", async () => {
    const sink = vi.fn().mockResolvedValue({ fired: true, alertId: "x" });
    const result = await reportTrpcError(
      {
        error: new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "duplicate key value violates unique constraint",
        }),
        type: "mutation",
        path: "factoryOrders.approve",
      },
      sink,
    );
    expect(result.posted).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    const call = sink.mock.calls[0][0];
    expect(call.severity).toBe("p1");
    expect(call.dedupKey).toBe("trpc.error:factoryOrders.approve");
    expect(call.title).toContain("factoryOrders.approve");
    expect(call.title).toContain("INTERNAL_SERVER_ERROR");
    expect(call.fields.procedure).toBe("factoryOrders.approve");
    expect(call.fields.type).toBe("mutation");
    expect(call.fields.code).toBe("INTERNAL_SERVER_ERROR");
    expect(call.fields.error).toContain("duplicate key value");
  });

  it("does NOT fire for user-facing error codes", async () => {
    const sink = vi.fn().mockResolvedValue({ fired: true, alertId: "x" });
    const codes = [
      "BAD_REQUEST",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "PRECONDITION_FAILED",
      "UNPROCESSABLE_CONTENT",
      "TOO_MANY_REQUESTS",
    ] as const;
    for (const code of codes) {
      const result = await reportTrpcError(
        {
          error: new TRPCError({ code, message: "x" }),
          type: "query",
          path: "test.proc",
        },
        sink,
      );
      expect(result.posted).toBe(false);
      expect(result.reason).toContain("code_not_alertable");
    }
    expect(sink).not.toHaveBeenCalled();
  });

  it("truncates the error preview to 240 chars to avoid Slack payload bloat", async () => {
    const sink = vi.fn().mockResolvedValue({ fired: true, alertId: "x" });
    const longMessage = "x".repeat(2000);
    await reportTrpcError(
      {
        error: new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: longMessage,
        }),
        type: "mutation",
        path: "test.proc",
      },
      sink,
    );
    const call = sink.mock.calls[0][0];
    expect(String(call.fields.error).length).toBe(240);
  });

  it("uses cause.message when the TRPCError wraps an underlying error", async () => {
    const sink = vi.fn().mockResolvedValue({ fired: true, alertId: "x" });
    const cause = new Error("ECONNREFUSED 127.0.0.1:5432");
    await reportTrpcError(
      {
        error: new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Something went wrong",
          cause,
        }),
        type: "query",
        path: "test.proc",
      },
      sink,
    );
    const call = sink.mock.calls[0][0];
    expect(call.fields.error).toContain("ECONNREFUSED");
  });

  it("returns posted=false but does not throw when the sink rejects", async () => {
    const sink = vi.fn().mockRejectedValue(new Error("db connection blip"));
    const result = await reportTrpcError(
      {
        error: new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "x",
        }),
        type: "query",
        path: "test.proc",
      },
      sink,
    );
    expect(result.posted).toBe(false);
    expect(result.reason).toBe("sink_threw");
  });

  it("handles missing path gracefully (path = <unknown>)", async () => {
    const sink = vi.fn().mockResolvedValue({ fired: true, alertId: "x" });
    await reportTrpcError(
      {
        error: new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "x",
        }),
        type: "unknown",
      },
      sink,
    );
    const call = sink.mock.calls[0][0];
    expect(call.dedupKey).toBe("trpc.error:<unknown>");
  });
});
