import { router } from "@/lib/trpc/server";
import { adminRouter } from "./admin";
import { cashflowRouter } from "./cashflow";
import { factoryOrderRouter } from "./factory-order";
import { inventoryRouter } from "./inventory";
import { pipelineRouter } from "./pipeline";
import { shippingAuditRouter } from "./shipping-audit";

export const appRouter = router({
  admin: adminRouter,
  cashflow: cashflowRouter,
  factoryOrder: factoryOrderRouter,
  inventory: inventoryRouter,
  pipeline: pipelineRouter,
  shippingAudit: shippingAuditRouter,
});
export type AppRouter = typeof appRouter;
