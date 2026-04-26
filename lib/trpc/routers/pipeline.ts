import { z } from "zod";
import { getLatestPullsPerSource, getPullHistoryAllSources } from "@/lib/queries/pipeline";
import { publicProcedure, router } from "@/lib/trpc/server";

export const pipelineRouter = router({
  getLatestPullsPerSource: publicProcedure.query(() => getLatestPullsPerSource()),

  // Per-source pull history for the Pipeline status page (SPEC §3.6).
  // Caps `limitPerSource` server-side so a misconfigured client can't
  // pull a runaway result set even if the URL gets crafted by hand.
  getPullHistoryAllSources: publicProcedure
    .input(
      z
        .object({ limitPerSource: z.number().int().min(1).max(200).optional() })
        .optional(),
    )
    .query(({ input }) =>
      getPullHistoryAllSources(input?.limitPerSource ?? 30),
    ),
});
