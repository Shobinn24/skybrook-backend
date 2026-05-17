import Link from "next/link";
import type { Role } from "@/lib/auth";

// Single link spec, shared by both ops and marketing renders. `roles`
// determines which user role sees each entry; admin links live in a
// separate ops-only section below.
const NAV_ITEMS: ReadonlyArray<{ href: string; label: string; roles: ReadonlyArray<Role> }> = [
  { href: "/inventory",      label: "Inventory",      roles: ["ops"] },
  { href: "/incoming",       label: "Incoming",       roles: ["ops"] },
  { href: "/sustainability", label: "Sustainability", roles: ["ops"] },
  { href: "/overstock",      label: "Overstock",      roles: ["ops"] },
  { href: "/stock-value",    label: "Stock value",    roles: ["ops"] },
  { href: "/performance",    label: "Performance",    roles: ["ops", "marketing"] },
  { href: "/launches",       label: "Launches",       roles: ["ops", "marketing"] },
  { href: "/fb-ads",         label: "FB Ads Tracker", roles: ["ops", "marketing"] },
  { href: "/bonus-tracker",  label: "Bonus Tracker",  roles: ["ops", "marketing"] },
];

const LINK_CLS = "block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100";

export function LeftNav({ role = "ops" }: { role?: Role }) {
  const items = NAV_ITEMS.filter((i) => i.roles.includes(role));
  return (
    <aside className="w-56 shrink-0 border-r border-neutral-200 bg-white p-4 space-y-1 text-sm">
      <div className="mb-3 font-semibold text-neutral-900">Skybrook</div>
      {items.map((item) => (
        <Link key={item.href} href={item.href} className={LINK_CLS}>
          {item.label}
        </Link>
      ))}
      {role === "ops" && (
        <div className="!mt-4 border-t border-neutral-200 pt-3">
          <div className="mb-1 px-2 text-[11px] uppercase tracking-wide text-neutral-400">
            Admin
          </div>
          <Link href="/admin/product-names" className={LINK_CLS}>
            Product names
          </Link>
          <Link href="/pipeline" className={LINK_CLS}>
            Pipeline
          </Link>
        </div>
      )}
    </aside>
  );
}
