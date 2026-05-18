import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createContext } from "@/lib/trpc/context";
import { appRouter } from "@/lib/trpc/routers";
import { reportTrpcError } from "@/lib/notifications/trpc-error-tap";

export const runtime = "nodejs";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
    // Procedure-level crash → Slack P1. Only fires on
    // INTERNAL_SERVER_ERROR; user-facing 4xx codes are filtered out
    // inside reportTrpcError so we don't page on validation failures.
    // Fire-and-forget: never block the request response on Slack.
    onError: (opts) => {
      void reportTrpcError({
        error: opts.error,
        type: opts.type,
        path: opts.path,
        input: opts.input,
      });
    },
  });

export { handler as GET, handler as POST };
