import type { Location } from "./warehouse-routing";

export type SaleEvent = {
  sku: string;
  quantity: number;
  orderDateEst: string; // YYYY-MM-DD
  routedLocation: Location;
};

export function computeVelocity(input: {
  events: SaleEvent[];
  asOfDate: string;
  windowDays: number;
  sku?: string;
  routedLocation?: Location;
}): number {
  const end = new Date(`${input.asOfDate}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (input.windowDays - 1));
  const startStr = start.toISOString().slice(0, 10);
  const endStr = input.asOfDate;

  let total = 0;
  for (const e of input.events) {
    if (input.sku && e.sku !== input.sku) continue;
    if (input.routedLocation && e.routedLocation !== input.routedLocation) continue;
    if (e.orderDateEst < startStr || e.orderDateEst > endStr) continue;
    total += e.quantity;
  }
  return total / input.windowDays;
}
