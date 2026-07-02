import Link from "next/link";
import type { Role } from "@/lib/auth";

// Single link spec, shared by both ops and marketing renders. `roles`
// determines which user role sees each entry; admin links live in a
// separate ops-only section below. `fbAdsOnly` marks the entries an
// fb-ads-only session may actually load (must mirror
// isFbAdsOnlyAllowedPath in lib/auth.ts) — those users get ONLY these
// links so their nav never shows dead, redirecting entries.
const NAV_ITEMS: ReadonlyArray<{
  href: string;
  label: string;
  roles: ReadonlyArray<Role>;
  fbAdsOnly?: boolean;
}> = [
  { href: "/inventory",      label: "Inventory",      roles: ["ops"] },
  { href: "/incoming",       label: "Incoming",       roles: ["ops"] },
  { href: "/sustainability", label: "Sustainability", roles: ["ops"] },
  { href: "/overstock",      label: "Overstock",      roles: ["ops"] },
  { href: "/stock-value",    label: "Stock value",    roles: ["ops"] },
  { href: "/performance",    label: "Performance",    roles: ["ops", "marketing"] },
  { href: "/launches",       label: "Launches",       roles: ["ops", "marketing"] },
  { href: "/fb-ads",         label: "FB Ads Tracker", roles: ["ops", "marketing"], fbAdsOnly: true },
  { href: "/bonus-tracker",  label: "Bonus Tracker",  roles: ["ops", "marketing"], fbAdsOnly: true },
  { href: "/shipping-performance", label: "Shipping",   roles: ["ops"] },
  { href: "/factory-orders",       label: "Factory Orders", roles: ["ops"] },
];

const LINK_CLS = "block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100";

export function LeftNav({
  role = "ops",
  showCashflow = false,
  fbAdsOnly = false,
}: {
  role?: Role;
  // Cashflow is gated to its own allowlist (SKYBROOK_CASHFLOW_EMAILS), not the
  // ops/marketing role, so the link is shown independently of `role`.
  showCashflow?: boolean;
  // fb-ads-only tier (external media buyers): overrides `role` and shows
  // only the entries flagged fbAdsOnly above — everything else would
  // just redirect at the middleware. Client 2026-07-02 added
  // /bonus-tracker (read-only) alongside /fb-ads.
  fbAdsOnly?: boolean;
}) {
  const items = fbAdsOnly
    ? NAV_ITEMS.filter((i) => i.fbAdsOnly)
    : NAV_ITEMS.filter((i) => i.roles.includes(role));
  return (
    <aside className="w-56 shrink-0 border-r border-neutral-200 bg-white p-4 space-y-1 text-sm">
      <div className="mb-3 font-semibold text-neutral-900">Skybrook</div>
      {items.map((item) => (
        <Link key={item.href} href={item.href} className={LINK_CLS}>
          {item.label}
        </Link>
      ))}
      {/* Admin section shows for ops (its admin links) and/or for anyone on
          the cashflow allowlist (the Cashflow link) — the latter is independent
          of the ops/marketing role. Never for fb-ads-only sessions. */}
      {!fbAdsOnly && (role === "ops" || showCashflow) && (
        <div className="!mt-4 border-t border-neutral-200 pt-3">
          <div className="mb-1 px-2 text-[11px] uppercase tracking-wide text-neutral-400">
            Admin
          </div>
          {role === "ops" && (
            <>
              <Link href="/admin/product-names" className={LINK_CLS}>
                Product names
              </Link>
              <Link href="/admin/data-sources" className={LINK_CLS}>
                Data sources
              </Link>
              <Link href="/pipeline" className={LINK_CLS}>
                Pipeline
              </Link>
            </>
          )}
          {showCashflow && (
            <Link href="/cashflow" className={LINK_CLS}>
              Cashflow
            </Link>
          )}
        </div>
      )}
    </aside>
  );
}
