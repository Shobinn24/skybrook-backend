"use client";
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc/client";


function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function num(s: string): number {
  return Number(s.replace(/[$,%\s]/g, ""));
}
function mondayOfThisWeek(): string {
  const now = new Date();
  const dow = now.getUTCDay();
  const delta = (dow + 6) % 7;
  now.setUTCDate(now.getUTCDate() - delta);
  return now.toISOString().slice(0, 10);
}

// Per-week line items requested by the owner (2026-06-09):
// Begin + Profit + COGS − Payouts − Bulk orders − Other = End.
type GridWeek = { weekStart: string; beginning: number; ending: number; byCategory: Record<string, number> };

// "Other payments" = every category that isn't one of the named lines
// (e.g. Google/Meta ad invoices, sales tax, payroll — the manual entries).
const NAMED_LINE_KEYS = new Set(["net_profit", "cogs", "profit_payout", "bulk_order"]);
function otherOutTotal(byCategory: Record<string, number>): number {
  return Object.entries(byCategory)
    .filter(([k]) => !NAMED_LINE_KEYS.has(k))
    .reduce((sum, [, v]) => sum + v, 0); // signed; out categories are negative
}

const LINE_ITEMS: ReadonlyArray<{ label: string; bold?: boolean; get: (w: GridWeek) => number }> = [
  { label: "Begin", get: (w) => w.beginning },
  { label: "+ Profit", get: (w) => w.byCategory.net_profit ?? 0 },
  { label: "+ COGS", get: (w) => w.byCategory.cogs ?? 0 },
  { label: "− Payouts", get: (w) => Math.abs(w.byCategory.profit_payout ?? 0) },
  { label: "− Bulk orders", get: (w) => Math.abs(w.byCategory.bulk_order ?? 0) },
  { label: "− Other", get: (w) => Math.abs(otherOutTotal(w.byCategory)) },
  { label: "End", bold: true, get: (w) => w.ending },
];

type ManualCategory =
  | "sales_tax" | "tax" | "payroll" | "whitelisting" | "software" | "agency"
  | "ad_spend_google" | "ad_spend_meta" | "tatari" | "bulk_order" | "one_off";

const EXPENSE_CATEGORIES: ReadonlyArray<readonly [ManualCategory, string]> = [
  ["sales_tax", "Sales tax"],
  ["payroll", "Payroll"],
  ["whitelisting", "Whitelisting"],
  ["software", "Software"],
  ["ad_spend_google", "Google Ads invoice"],
  ["ad_spend_meta", "Meta invoice"],
  ["tatari", "Tatari"],
  ["tax", "Tax"],
  ["agency", "Agency"],
  ["bulk_order", "Bulk order"],
  ["one_off", "One-off"],
];
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(EXPENSE_CATEGORIES);

const INPUT_CLS = "block border rounded px-2 py-1 text-sm";
const BTN_CLS = "border rounded px-3 py-1 text-sm";

export default function CashflowPage() {
  const firstWeek = useMemo(mondayOfThisWeek, []);
  const utils = trpc.useUtils();
  const invalidateAll = () => {
    void utils.cashflow.getGrid.invalidate();
    void utils.cashflow.listManualEntries.invalidate();
  };

  const grid = trpc.cashflow.getGrid.useQuery({ firstWeekStart: firstWeek });
  const assumptions = trpc.cashflow.getAssumptions.useQuery();
  const manual = trpc.cashflow.listManualEntries.useQuery({ firstWeekStart: firstWeek });

  const enterCash = trpc.cashflow.enterWeeklyCash.useMutation({ onSuccess: invalidateAll });
  const setPayout = trpc.cashflow.setPayout.useMutation({ onSuccess: invalidateAll });
  const setReason = trpc.cashflow.setVarianceReason.useMutation({ onSuccess: invalidateAll });
  const saveAssumptions = trpc.cashflow.setAssumptions.useMutation({ onSuccess: invalidateAll });
  const addEntry = trpc.cashflow.addManualEntry.useMutation({ onSuccess: invalidateAll });
  const delEntry = trpc.cashflow.deleteManualEntry.useMutation({ onSuccess: invalidateAll });

  const [cashInput, setCashInput] = useState("");
  const [payoutInput, setPayoutInput] = useState("");
  const [showAssumptions, setShowAssumptions] = useState(false);

  if (grid.isLoading) return <div className="p-6">Loading cashflow…</div>;
  if (grid.error) return <div className="p-6 text-red-600">Error: {grid.error.message}</div>;
  const data = grid.data!;
  const wk0 = data.weeks[0];
  const firstShortage = data.weeks.find((w) => w.ending < 0);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Cashflow — week of {wk0.weekStart}</h1>

      {/* Headline banner */}
      <div className="rounded border p-4 space-y-1">
        {firstShortage ? (
          <p className="text-red-600 font-medium">
            ⚠ Shortage forecast: {fmtMoney(firstShortage.ending)} on week of {firstShortage.weekStart}
          </p>
        ) : (
          <p className="text-green-700 font-medium">No shortage in the next 13 weeks.</p>
        )}
        {wk0.actualEnding == null && (
          <p className="text-amber-700">⏰ No total-cash entered for this week — enter it for accurate variance.</p>
        )}
      </div>

      {/* This week's ritual */}
      <div className="rounded border p-4 space-y-3">
        <h2 className="font-medium">This week</h2>
        <div className="flex items-end gap-2">
          <label className="text-sm">Total cash on hand
            <input className={`${INPUT_CLS} w-48`} inputMode="decimal"
              value={cashInput} onChange={(e) => setCashInput(e.target.value)} placeholder="e.g. 200000" />
          </label>
          <button className={`${BTN_CLS} bg-black text-white`}
            disabled={enterCash.isPending || cashInput.trim() === ""}
            onClick={() => { enterCash.mutate({ weekStart: wk0.weekStart, totalCashUsd: num(cashInput) }); setCashInput(""); }}>
            Save balance
          </button>
        </div>

        {wk0.variance != null && wk0.varianceSignificant && (
          <div className="rounded bg-amber-50 p-3 space-y-2">
            <p>Variance vs forecast: <strong>{fmtMoney(wk0.variance)}</strong> (over {fmtMoney(data.thresholdUsd)})</p>
            <div className="flex gap-2">
              {(["volume", "spending", "timing"] as const).map((r) => (
                <button key={r} className={`${BTN_CLS} ${wk0.varianceReason === r ? "bg-black text-white" : ""}`}
                  onClick={() => setReason.mutate({ weekStart: wk0.weekStart, reason: r, note: null })}>{r}</button>
              ))}
            </div>
          </div>
        )}

        {/* Payout controls */}
        <div className="flex items-end gap-2 flex-wrap">
          <label className="text-sm">Payout this week ({fmtMoney(wk0.payout)})
            <input className={`${INPUT_CLS} w-40`} inputMode="decimal"
              value={payoutInput} onChange={(e) => setPayoutInput(e.target.value)} placeholder="override $" />
          </label>
          <button className={BTN_CLS}
            disabled={setPayout.isPending || payoutInput.trim() === ""}
            onClick={() => { setPayout.mutate({ weekStart: wk0.weekStart, overrideUsd: num(payoutInput) }); setPayoutInput(""); }}>
            Set payout
          </button>
          <button className={BTN_CLS} onClick={() => setPayout.mutate({ weekStart: wk0.weekStart, skipped: true })}>Skip payout</button>
          <button className={BTN_CLS} onClick={() => setPayout.mutate({ weekStart: wk0.weekStart, skipped: false, overrideUsd: null })}>Reset payout</button>
        </div>
      </div>

      {/* Forecast assumptions (collapsible) */}
      <div className="rounded border p-4">
        <button className="font-medium" onClick={() => setShowAssumptions((s) => !s)}>
          {showAssumptions ? "▾" : "▸"} Forecast assumptions
        </button>
        {showAssumptions && assumptions.data && (
          <AssumptionsEditor
            initial={assumptions.data}
            pending={saveAssumptions.isPending}
            saved={saveAssumptions.isSuccess}
            onSave={(patch) => saveAssumptions.mutate({ patch, firstWeekStart: firstWeek })}
          />
        )}
      </div>

      {/* Manual entries */}
      <div className="rounded border p-4 space-y-3">
        <h2 className="font-medium">Manual entries (expenses)</h2>
        <ManualEntryForm
          defaultDate={firstWeek}
          pending={addEntry.isPending}
          onAdd={(e) => addEntry.mutate({ ...e })}
        />
        <ul className="text-sm divide-y">
          {(manual.data ?? []).map((m) => (
            <li key={m.ref} className="flex items-center justify-between py-1">
              <span>
                {CATEGORY_LABEL[m.category] ?? m.category} — {fmtMoney(Number(m.amountUsd))}
                {m.recurring ? ` /mo (from ${m.firstDate})` : ` on ${m.firstDate}`}
                {m.description ? ` · ${m.description}` : ""}
              </span>
              <button className="text-red-600 hover:underline" onClick={() => delEntry.mutate({ ref: m.ref })}>remove</button>
            </li>
          ))}
          {(manual.data ?? []).length === 0 && <li className="py-1 text-neutral-500">No manual entries yet.</li>}
        </ul>
      </div>

      {/* 13-week grid */}
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse">
          <thead>
            <tr><th className="text-left p-1"></th>
              {data.weeks.map((w) => <th key={w.weekStart} className="p-1 text-right whitespace-nowrap">{w.weekStart.slice(5)}</th>)}
            </tr>
          </thead>
          <tbody>
            {LINE_ITEMS.map((item) => (
              <tr key={item.label} className={item.bold ? "font-medium border-t border-gray-300" : ""}>
                <td className="p-1 pr-3 whitespace-nowrap">{item.label}</td>
                {data.weeks.map((w) => (
                  <td key={w.weekStart} className={`p-1 text-right ${item.label === "End" && w.ending < 0 ? "text-red-600" : ""}`}>
                    {fmtMoney(item.get(w))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Assumptions = {
  ev: { revenueStart: number; weeklyGrowth: number; netMargin: number };
  jm: { revenueStart: number; weeklyGrowth: number; netMargin: number };
  ewc: { revenueStart: number; weeklyGrowth: number; netMargin: number };
  cogsPct: number;
  profitPayoutPct: number;
  varianceThresholdUsd: number;
};

function AssumptionsEditor({
  initial,
  pending,
  saved,
  onSave,
}: {
  initial: Assumptions;
  pending: boolean;
  saved: boolean;
  onSave: (patch: Record<string, number>) => void;
}) {
  // Percent fields are shown as whole numbers (18 = 18%) and converted on save.
  const [f, setF] = useState({
    evRevenueStart: String(initial.ev.revenueStart), evWeeklyGrowth: String(initial.ev.weeklyGrowth), evNetMargin: String(initial.ev.netMargin * 100),
    jmRevenueStart: String(initial.jm.revenueStart), jmWeeklyGrowth: String(initial.jm.weeklyGrowth), jmNetMargin: String(initial.jm.netMargin * 100),
    ewcRevenueStart: String(initial.ewc.revenueStart), ewcWeeklyGrowth: String(initial.ewc.weeklyGrowth), ewcNetMargin: String(initial.ewc.netMargin * 100),
    cogsPct: String(initial.cogsPct * 100), profitPayoutPct: String(initial.profitPayoutPct * 100), varianceThresholdUsd: String(initial.varianceThresholdUsd),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const field = (k: keyof typeof f, label: string) => (
    <label className="text-sm">{label}
      <input className={`${INPUT_CLS} w-36`} inputMode="decimal" value={f[k]} onChange={set(k)} />
    </label>
  );

  return (
    <div className="mt-3 space-y-3">
      {(["ev", "jm", "ewc"] as const).map((ch) => (
        <div key={ch} className="flex gap-3 flex-wrap">
          {field(`${ch}RevenueStart` as keyof typeof f, `${ch.toUpperCase()} revenue/wk`)}
          {field(`${ch}WeeklyGrowth` as keyof typeof f, `${ch.toUpperCase()} growth (1.0=flat)`)}
          {field(`${ch}NetMargin` as keyof typeof f, `${ch.toUpperCase()} margin %`)}
        </div>
      ))}
      <div className="flex gap-3 flex-wrap">
        {field("cogsPct", "COGS %")}
        {field("profitPayoutPct", "Profit payout %")}
        {field("varianceThresholdUsd", "Variance flag $")}
      </div>
      <div className="flex items-center gap-3">
        <button className={`${BTN_CLS} bg-black text-white`} disabled={pending}
          onClick={() => onSave({
            evRevenueStart: num(f.evRevenueStart), evWeeklyGrowth: num(f.evWeeklyGrowth), evNetMargin: num(f.evNetMargin) / 100,
            jmRevenueStart: num(f.jmRevenueStart), jmWeeklyGrowth: num(f.jmWeeklyGrowth), jmNetMargin: num(f.jmNetMargin) / 100,
            ewcRevenueStart: num(f.ewcRevenueStart), ewcWeeklyGrowth: num(f.ewcWeeklyGrowth), ewcNetMargin: num(f.ewcNetMargin) / 100,
            cogsPct: num(f.cogsPct) / 100, profitPayoutPct: num(f.profitPayoutPct) / 100, varianceThresholdUsd: num(f.varianceThresholdUsd),
          })}>
          {pending ? "Saving..." : "Save assumptions"}
        </button>
        {saved && !pending && <span className="text-sm text-green-600">Saved ✓</span>}
      </div>
    </div>
  );
}

function ManualEntryForm({
  defaultDate,
  pending,
  onAdd,
}: {
  defaultDate: string;
  pending: boolean;
  onAdd: (e: { category: ManualCategory; amountUsd: number; cashDate: string; description: string; repeatMonthly: boolean }) => void;
}) {
  const [category, setCategory] = useState<ManualCategory>(EXPENSE_CATEGORIES[0][0]);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [description, setDescription] = useState("");
  const [repeatMonthly, setRepeatMonthly] = useState(false);

  return (
    <div className="flex items-end gap-2 flex-wrap">
      <label className="text-sm">Category
        <select className={INPUT_CLS} value={category} onChange={(e) => setCategory(e.target.value as ManualCategory)}>
          {EXPENSE_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className="text-sm">Amount
        <input className={`${INPUT_CLS} w-32`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 45000" />
      </label>
      <label className="text-sm">Date
        <input className={INPUT_CLS} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="text-sm">Note
        <input className={`${INPUT_CLS} w-40`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
      </label>
      <label className="text-sm inline-flex items-center gap-1">
        <input type="checkbox" checked={repeatMonthly} onChange={(e) => setRepeatMonthly(e.target.checked)} /> monthly
      </label>
      <button className={`${BTN_CLS} bg-black text-white`} disabled={pending || amount.trim() === ""}
        onClick={() => { onAdd({ category, amountUsd: num(amount), cashDate: date, description, repeatMonthly }); setAmount(""); setDescription(""); }}>
        Add
      </button>
    </div>
  );
}
