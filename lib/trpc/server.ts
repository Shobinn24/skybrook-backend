import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import type { AccessTier } from "@/lib/auth";

const t = initTRPC.context<TrpcContext>().create({ transformer: superjson });

export const router = t.router;

// --- Tier-scoped procedure builders -----------------------------------------
// Authorization is default-deny: there is NO ungated procedure builder.
// Every procedure must pick the minimum tier that needs it:
//
//   fbAdsProcedure      — fb_ads_only + marketing + ops (the /fb-ads page
//                         rollup and the shared shell's pull-status widget)
//   marketingProcedure  — marketing + ops (launches / bonus tracker /
//                         performance surfaces)
//   opsProcedure        — ops only (everything else: inventory, stock,
//                         incoming, sustainability, factory orders, admin)
//   cashflowProcedure   — SKYBROOK_CASHFLOW_EMAILS allowlist only,
//                         independent of tier (company cash position)
//
// The viewer tier (client 2026-07-21: external collaborator with VIEW
// access to all parts) cuts across every tier builder: requireTier
// admits a viewer session to QUERY procedures regardless of the
// builder's tier list, and rejects every mutation. cashflowProcedure
// does not go through requireTier, so viewers cannot read cashflow
// unless they are also on the cashflow allowlist.
//
// All builders also reject sessions without an email (UNAUTHORIZED) and
// narrow ctx.email to string so mutations can attribute writes safely.

const requireSession = t.middleware(({ ctx, next }) => {
  if (!ctx.email) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "no session" });
  }
  return next({ ctx: { ...ctx, email: ctx.email } });
});

function requireTier(allowed: ReadonlyArray<AccessTier>) {
  return t.middleware(({ ctx, type, next }) => {
    if (!ctx.email) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "no session" });
    }
    // Viewer tier: read-only everything. Queries pass every tier
    // builder; mutations (and subscriptions) fall through to the
    // normal tier check and reject.
    const viewerRead = ctx.tier === "viewer" && type === "query";
    if (!allowed.includes(ctx.tier) && !viewerRead) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "your account does not have access to this resource",
      });
    }
    return next({ ctx: { ...ctx, email: ctx.email } });
  });
}

export const fbAdsProcedure = t.procedure.use(
  requireTier(["ops", "marketing", "fb_ads_only"]),
);

export const marketingProcedure = t.procedure.use(
  requireTier(["ops", "marketing"]),
);

export const opsProcedure = t.procedure.use(requireTier(["ops"]));

// Reviews + Sizing read surface (client 2026-07-17: external collaborator
// sees only those two pages). Mutations on those pages stay opsProcedure.
export const reviewsProcedure = t.procedure.use(requireTier(["ops", "reviews_only"]));

// Shared shell queries every signed-in tier needs (pull-status widget,
// own access tier). Data is benign: source freshness metadata plus the
// session's own tier.
export const shellProcedure = t.procedure.use(
  requireTier(["ops", "marketing", "fb_ads_only", "reviews_only"]),
);

export const cashflowProcedure = t.procedure
  .use(requireSession)
  .use(
    t.middleware(({ ctx, next }) => {
      if (!ctx.cashflowAllowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "your account does not have access to cashflow data",
        });
      }
      return next();
    }),
  );
