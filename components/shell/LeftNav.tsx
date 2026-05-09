import Link from "next/link";

export function LeftNav() {
  return (
    <aside className="w-56 shrink-0 border-r border-neutral-200 bg-white p-4 space-y-1 text-sm">
      <div className="mb-3 font-semibold text-neutral-900">Skybrook</div>
      <Link
        href="/inventory"
        className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
      >
        Inventory
      </Link>
      <Link
        href="/incoming"
        className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
      >
        Incoming
      </Link>
      <Link
        href="/sustainability"
        className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
      >
        Sustainability
      </Link>
      <Link
        href="/overstock"
        className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
      >
        Overstock
      </Link>
      <Link
        href="/stock-value"
        className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
      >
        Stock value
      </Link>
      <Link
        href="/pipeline"
        className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
      >
        Pipeline
      </Link>
      <Link
        href="/performance"
        className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
      >
        Performance
      </Link>
      <Link
        href="/launches"
        className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
      >
        Launches
      </Link>
      <div className="!mt-4 border-t border-neutral-200 pt-3">
        <div className="mb-1 px-2 text-[11px] uppercase tracking-wide text-neutral-400">
          Admin
        </div>
        <Link
          href="/admin/product-names"
          className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
        >
          Product names
        </Link>
      </div>
    </aside>
  );
}
