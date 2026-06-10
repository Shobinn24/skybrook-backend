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
// All builders also reject sessions without an email (UNAUTHORIZED) and
// narrow ctx.email to string so mutations can attribute writes safely.

const requireSession = t.middleware(({ ctx, next }) => {
  if (!ctx.email) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "no session" });
  }
  return next({ ctx: { ...ctx, email: ctx.email } });
});

function requireTier(allowed: ReadonlyArray<AccessTier>) {
  return t.middleware(({ ctx, next }) => {
    if (!ctx.email) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "no session" });
    }
    if (!allowed.includes(ctx.tier)) {
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
