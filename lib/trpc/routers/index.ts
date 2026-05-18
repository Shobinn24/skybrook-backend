import { router } from "@/lib/trpc/server";
import { adminRouter } from "./admin";
import { inventoryRouter } from "./inventory";
import { pipelineRouter } from "./pipeline";
import { shippingAuditRouter } from "./shipping-audit";

export const appRouter = router({
  admin: adminRouter,
  inventory: inventoryRouter,
  pipeline: pipelineRouter,
  shippingAudit: shippingAuditRouter,
});
export type AppRouter = typeof appRouter;
