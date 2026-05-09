import { router } from "@/lib/trpc/server";
import { adminRouter } from "./admin";
import { inventoryRouter } from "./inventory";
import { pipelineRouter } from "./pipeline";

export const appRouter = router({
  admin: adminRouter,
  inventory: inventoryRouter,
  pipeline: pipelineRouter,
});
export type AppRouter = typeof appRouter;
