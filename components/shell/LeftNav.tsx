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
        href="/sustainability"
        className="block rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100"
      >
        Sustainability
      </Link>
      <span
        className="block cursor-not-allowed rounded px-2 py-1.5 text-neutral-400"
        title="Deferred until Meta ingestion is decided"
      >
        Performance
      </span>
    </aside>
  );
}
