"use client";
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc/client";

type FormState = {
  family: string;
  displayLabel: string;
  isImplicit5pack: boolean;
  aliasOf: string;
  // When editing an existing override, lock the family field so the
  // upsert hits the same row instead of creating a duplicate-ish one.
  familyLocked: boolean;
};

const EMPTY_FORM: FormState = {
  family: "",
  displayLabel: "",
  isImplicit5pack: false,
  aliasOf: "",
  familyLocked: false,
};

function fmtTimestamp(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// User-facing label for the row's source. Internal constant names
// (FAMILY_LABELS / MULTI_FAMILY_LABELS / FAMILY_ALIAS) are too jargon-y
// for the admin UI — collapse them to "Built-in" / "Built-in alias".
function sourceLabel(raw: string): string {
  if (raw === "DB override") return "Override";
  if (raw === "FAMILY_ALIAS") return "Built-in alias";
  if (raw === "FAMILY_LABELS" || raw === "MULTI_FAMILY_LABELS") return "Built-in";
  return raw;
}

export default function ProductNamesAdminPage() {
  const utils = trpc.useUtils();
  const overrides = trpc.admin.listOverrides.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const known = trpc.admin.listKnownFamilies.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const unmapped = trpc.admin.listUnmappedFamilies.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  const upsert = trpc.admin.upsertOverride.useMutation({
    onSuccess: () => {
      void utils.admin.listOverrides.invalidate();
      void utils.admin.listUnmappedFamilies.invalidate();
      setForm(null);
    },
  });
  const remove = trpc.admin.deleteOverride.useMutation({
    onSuccess: () => {
      void utils.admin.listOverrides.invalidate();
      void utils.admin.listUnmappedFamilies.invalidate();
    },
  });
  const runSync = trpc.admin.runProductNamesSync.useMutation({
    onSuccess: () => {
      void utils.admin.listUnmappedFamilies.invalidate();
    },
  });

  const [form, setForm] = useState<FormState | null>(null);
  const [search, setSearch] = useState("");

  // Merge DB overrides with constants snapshot. Override entry wins —
  // a constant family that has been overridden hides the constant row
  // and shows the override (with source="DB override").
  const merged = useMemo(() => {
    const overrideMap = new Map<
      string,
      { family: string; displayLabel: string; isImplicit5pack: boolean; aliasOf: string | null; source: string; updatedAt: string | null; updatedBy: string | null }
    >();
    for (const o of overrides.data ?? []) {
      overrideMap.set(o.family, {
        family: o.family,
        displayLabel: o.aliasOf ? "—" : o.displayLabel,
        isImplicit5pack: o.isImplicit5pack,
        aliasOf: o.aliasOf,
        source: "DB override",
        updatedAt: o.updatedAt,
        updatedBy: o.updatedBy,
      });
    }
    const rows: typeof overrideMap extends Map<string, infer V> ? V[] : never = [];
    for (const k of known.data ?? []) {
      if (overrideMap.has(k.family)) continue;
      rows.push({
        family: k.family,
        displayLabel: k.displayLabel ?? "—",
        isImplicit5pack: k.isImplicit5pack,
        aliasOf: k.aliasOf,
        source: k.source,
        updatedAt: null,
        updatedBy: null,
      });
    }
    for (const o of overrideMap.values()) rows.push(o);
    return rows
      .filter((r) => !search || r.family.includes(search.toLowerCase()))
      .sort((a, b) => a.family.localeCompare(b.family));
  }, [overrides.data, known.data, search]);

  const handleSave = () => {
    if (!form) return;
    if (!form.family) return;
    const aliasOf = form.aliasOf ? form.aliasOf.toLowerCase().trim() : null;
    // displayLabel is unused when aliasOf is set (deriveProductName
    // follows the alias before reading the label) but the schema still
    // requires NOT NULL — fall back to the family token when the user
    // didn't enter one explicitly. For non-alias entries displayLabel
    // remains required.
    const trimmedLabel = form.displayLabel.trim();
    const displayLabel = trimmedLabel || (aliasOf ? form.family : "");
    if (!displayLabel) return;
    upsert.mutate({
      family: form.family.toLowerCase().trim(),
      displayLabel,
      isImplicit5pack: form.isImplicit5pack,
      aliasOf,
    });
  };

  const startEdit = (
    family: string,
    displayLabel: string,
    isImplicit5pack: boolean,
    aliasOf: string | null
  ) => {
    setForm({
      family,
      displayLabel: displayLabel === "—" ? "" : displayLabel,
      isImplicit5pack,
      aliasOf: aliasOf ?? "",
      familyLocked: true,
    });
  };

  const overrideFamilies = new Set((overrides.data ?? []).map((o) => o.family));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Product names</h1>
          <p className="text-sm text-neutral-500">
            Tell the system what to display for SKU families on{" "}
            <a className="underline" href="/launches">/launches</a> and inventory rollups.
            For example,{" "}
            <code className="rounded bg-neutral-100 px-1">ev-cottonhip-5x-l</code>{" "}
            uses the entry for family <code className="rounded bg-neutral-100 px-1">cottonhip</code>.
            Changes apply on the next product-names sync — click Run sync now to apply immediately.
          </p>
        </div>
        {!form && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => runSync.mutate()}
              disabled={runSync.isPending}
              className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"
            >
              {runSync.isPending ? "Running…" : "Run sync now"}
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...EMPTY_FORM })}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
            >
              + Add override
            </button>
          </div>
        )}
      </div>

      {(runSync.data || runSync.error) && (
        <div
          className={`rounded border px-3 py-2 text-xs ${
            runSync.error
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {runSync.error ? (
            <>Sync failed: {runSync.error.message}</>
          ) : runSync.data ? (
            <>
              Sync complete — {runSync.data.fromPattern} resolved by parser,{" "}
              {runSync.data.fromSheet} from velocity sheet,{" "}
              {runSync.data.unchanged} unchanged.
            </>
          ) : null}
        </div>
      )}

      {form && (
        <div className="rounded border border-neutral-200 bg-neutral-50 p-3 space-y-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <label className="text-xs text-neutral-700">
              <span className="block">Family</span>
              <span className="block text-[11px] text-neutral-500">
                segment after <code className="font-mono">ev-</code>
              </span>
              <input
                type="text"
                value={form.family}
                onChange={(e) => setForm({ ...form, family: e.target.value })}
                disabled={form.familyLocked}
                placeholder="cottonhip"
                className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-sm disabled:bg-neutral-100"
              />
            </label>
            <label className="text-xs text-neutral-700 sm:col-span-2">
              <span className="block">Product name</span>
              <span className="block text-[11px] text-neutral-500">
                shown on /launches and rollups
              </span>
              <input
                type="text"
                value={form.displayLabel}
                onChange={(e) => setForm({ ...form, displayLabel: e.target.value })}
                placeholder="Cotton Hipster"
                className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-neutral-700">
              <span className="block">Alias of (optional)</span>
              <span className="block text-[11px] text-neutral-500">
                redirect to another family
              </span>
              <input
                type="text"
                value={form.aliasOf}
                onChange={(e) => setForm({ ...form, aliasOf: e.target.value })}
                placeholder="og"
                className="mt-0.5 block w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-sm"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-700">
            <input
              type="checkbox"
              checked={form.isImplicit5pack}
              onChange={(e) => setForm({ ...form, isImplicit5pack: e.target.checked })}
            />
            Drop &ldquo;5-Pack&rdquo; from product name (use for families that only ship in 5-packs)
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={
                !form.family ||
                (!form.displayLabel && !form.aliasOf) ||
                upsert.isPending
              }
              className="rounded bg-neutral-900 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {upsert.isPending ? "Saving…" : "Save override"}
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className="text-xs text-neutral-500 hover:text-neutral-800"
            >
              Cancel
            </button>
            {upsert.error && (
              <span className="text-xs text-red-700">{upsert.error.message}</span>
            )}
          </div>
        </div>
      )}

      {(unmapped.data ?? []).length > 0 && (
        <section className="rounded-md border border-amber-200 bg-amber-50">
          <div className="border-b border-amber-200 px-3 py-2">
            <h2 className="text-sm font-semibold text-amber-900">
              Unmapped families ({unmapped.data?.length ?? 0})
            </h2>
            <p className="text-xs text-amber-800">
              These SKU families don't resolve to a product name. Add a label so /launches stops
              showing raw SKU codes.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-amber-700">
              <tr>
                <th className="px-3 py-2">Family</th>
                <th className="px-3 py-2">Sample SKUs</th>
                <th className="px-3 py-2">SKUs</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-200">
              {(unmapped.data ?? []).map((u) => (
                <tr key={u.family}>
                  <td className="px-3 py-1.5 font-mono text-neutral-900">{u.family}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-neutral-700">
                    {u.sampleSkus.join(", ")}
                    {u.skuCount > u.sampleSkus.length && ` (+${u.skuCount - u.sampleSkus.length} more)`}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-neutral-700">{u.skuCount}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() =>
                        setForm({
                          ...EMPTY_FORM,
                          family: u.family,
                          familyLocked: true,
                        })
                      }
                      className="rounded bg-amber-700 px-2 py-1 text-xs font-medium text-white hover:bg-amber-800"
                    >
                      Add label
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="rounded-md border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
          <h2 className="text-sm font-semibold text-neutral-900">All entries</h2>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search family…"
            className="w-48 rounded border border-neutral-300 px-2 py-1 text-xs"
          />
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Family</th>
              <th className="px-3 py-2">Product name</th>
              <th className="px-3 py-2">Drop &ldquo;5-Pack&rdquo;</th>
              <th className="px-3 py-2">Alias of</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {merged.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-xs text-neutral-500">
                  {known.isLoading || overrides.isLoading ? "Loading…" : "No entries match."}
                </td>
              </tr>
            ) : (
              merged.map((r) => (
                <tr key={r.family} className="hover:bg-neutral-50/50">
                  <td className="px-3 py-1.5 font-mono text-neutral-900">{r.family}</td>
                  <td className="px-3 py-1.5 text-neutral-800">{r.displayLabel}</td>
                  <td className="px-3 py-1.5 text-neutral-700">
                    {r.aliasOf ? "—" : r.isImplicit5pack ? "✓" : ""}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-neutral-700">
                    {r.aliasOf ?? ""}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-neutral-500">
                    {sourceLabel(r.source)}
                    {r.updatedAt && r.updatedBy && (
                      <span className="block text-[11px] text-neutral-400">
                        {fmtTimestamp(r.updatedAt)} · {r.updatedBy}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() =>
                        startEdit(
                          r.family,
                          r.displayLabel,
                          r.isImplicit5pack,
                          r.aliasOf
                        )
                      }
                      className="text-xs text-neutral-700 underline-offset-2 hover:underline"
                    >
                      Edit
                    </button>
                    {overrideFamilies.has(r.family) && (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            confirm(
                              `Remove override for ${r.family}? The constant value (if any) will resume.`
                            )
                          ) {
                            remove.mutate({ family: r.family });
                          }
                        }}
                        className="ml-3 text-xs text-red-700 underline-offset-2 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
