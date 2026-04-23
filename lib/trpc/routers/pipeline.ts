import { getLatestPullsPerSource } from "@/lib/queries/pipeline";
import { publicProcedure, router } from "@/lib/trpc/server";

export const pipelineRouter = router({
  getLatestPullsPerSource: publicProcedure.query(() => getLatestPullsPerSource()),
});
