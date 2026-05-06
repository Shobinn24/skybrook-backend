import { thresholds } from "@/config/thresholds";
import { computeDaysOfStock } from "./days-of-stock";

export type Flag = "healthy" | "watch" | "at_risk" | "overstocked";

export type IncomingPO = {
  arrivalDate: string; // YYYY-MM-DD (EST calendar)
  quantity: number;
};

export type SustainabilityResult = {
  flag: Flag;
  reasoning: string;
  daysOfStock: number;
  runOutDate: string | null;
};

function daysBetween(fromYmd: string, toYmd: string): number {
  const f = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const t = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.round((t - f) / 86400000);
}

function addDays(fromYmd: string, days: number): string {
  const d = new Date(`${fromYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function computeSustainabilityFlag(input: {
  onHand: number;
  velocityPerDay: number;
  incoming: IncomingPO[];
  today: string; // YYYY-MM-DD EST
}): SustainabilityResult {
  const dos = computeDaysOfStock({ onHand: input.onHand, velocityPerDay: input.velocityPerDay });
  const dosDisplay = dos === Infinity ? "∞" : dos.toFixed(2);
  const totalIncoming = input.incoming.reduce((n, p) => n + p.quantity, 0);
  const reasoning = `on_hand=${input.onHand}, velocity=${input.velocityPerDay.toFixed(2)}/day, dos=${dosDisplay}, incoming=${totalIncoming} units over ${input.incoming.length} POs`;

  // No demand → flag as overstocked regardless of current stock. Projection
  // would divide by zero. Covers both (onHand>0, velocity=0) which gives
  // dos=Infinity and (onHand=0, velocity=0) which gives dos=0 — neither makes
  // sense to project forward through POs.
  if (input.velocityPerDay <= 0) {
    return { flag: "overstocked", reasoning, daysOfStock: Number.MAX_SAFE_INTEGER, runOutDate: null };
  }
  // Overstocked is gated on FUT WOS (future weeks of stock) per Scott's 2026-05-06
  // ask: includes still-incoming POs so a SKU isn't ruled overstocked by current
  // stock alone when a delivery is about to land, and isn't ruled out when current
  // stock looks healthy but a huge PO is en route.
  const futureStock = input.onHand + totalIncoming;
  const futureWeeks = futureStock / input.velocityPerDay / 7;
  if (futureWeeks > thresholds.overstockFutureWeeks) {
    return { flag: "overstocked", reasoning, daysOfStock: dos, runOutDate: null };
  }

  // Upcoming POs only (skip any in the past).
  const upcoming = input.incoming
    .filter((p) => p.arrivalDate > input.today)
    .sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));

  // Project forward through up to 2 POs.
  let stock = input.onHand;
  let currentDate = input.today;
  let poCount = 0;
  for (const po of upcoming) {
    const daysToPo = daysBetween(currentDate, po.arrivalDate);
    const stockAtPoArrival = stock - input.velocityPerDay * daysToPo;
    if (stockAtPoArrival <= 0) {
      const daysToZero = Math.floor(stock / input.velocityPerDay);
      const runOutDate = addDays(currentDate, daysToZero);
      const flag: Flag = poCount === 0 ? "at_risk" : "watch";
      return { flag, reasoning, daysOfStock: dos === Infinity ? Number.MAX_SAFE_INTEGER : dos, runOutDate };
    }
    stock = stockAtPoArrival + po.quantity;
    currentDate = po.arrivalDate;
    poCount += 1;
    if (poCount >= 2) break;
  }

  // Survived two POs → healthy. Overstock was already ruled out above using current DOS.
  if (poCount >= 2) {
    return { flag: "healthy", reasoning, daysOfStock: dos, runOutDate: null };
  }

  // Fewer than 2 POs were available to project through — fall back to DOS thresholds on the
  // stock we end up with after any partial projection.
  const remainingDos = input.velocityPerDay > 0 ? stock / input.velocityPerDay : Infinity;
  if (remainingDos < thresholds.atRiskDays) {
    return { flag: "at_risk", reasoning, daysOfStock: dos, runOutDate: null };
  }
  if (remainingDos <= thresholds.watchDays) {
    return { flag: "watch", reasoning, daysOfStock: dos, runOutDate: null };
  }
  return { flag: "healthy", reasoning, daysOfStock: dos, runOutDate: null };
}
