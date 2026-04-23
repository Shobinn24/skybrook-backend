import { router } from "@/lib/trpc/server";
import { inventoryRouter } from "./inventory";
import { pipelineRouter } from "./pipeline";

export const appRouter = router({
  inventory: inventoryRouter,
  pipeline: pipelineRouter,
});
export type AppRouter = typeof appRouter;
