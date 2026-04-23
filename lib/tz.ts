import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

const TZ = "America/New_York";

export function toEstDate(d: Date): string {
  return formatInTimeZone(d, TZ, "yyyy-MM-dd");
}

export function estDayStart(ymd: string): Date {
  return fromZonedTime(`${ymd}T00:00:00`, TZ);
}

export function estDayEnd(ymd: string): Date {
  const next = new Date(`${ymd}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextYmd = next.toISOString().slice(0, 10);
  return fromZonedTime(`${nextYmd}T00:00:00`, TZ);
}

export function nowEst(): string {
  return formatInTimeZone(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
}
