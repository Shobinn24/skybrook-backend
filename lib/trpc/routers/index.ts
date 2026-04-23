import { router } from "@/lib/trpc/server";
import { inventoryRouter } from "./inventory";

export const appRouter = router({
  inventory: inventoryRouter,
});
export type AppRouter = typeof appRouter;
