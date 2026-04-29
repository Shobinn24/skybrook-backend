"use client";
import { clsx } from "clsx";

export type Warehouse = "US" | "CN";
// Pages can opt into the All view by widening their state to this type
// and passing showAll=true to the toggle. Underlying queries keep
// taking a single Location — pages run both (US + CN) and concat /
// stack when "All" is active.
export type WarehouseSelection = Warehouse | "All";

// Discriminated union on `showAll` so pages that only support US/CN
// keep their narrow setState<Warehouse>, while pages opting into "All"
// widen to setState<WarehouseSelection>. Avoids forcing every consumer
// to handle the "All" case it can never receive.
type WarehouseToggleProps =
  | {
      showAll: true;
      value: WarehouseSelection;
      onChange: (w: WarehouseSelection) => void;
    }
  | {
      showAll?: false;
      value: Warehouse;
      onChange: (w: Warehouse) => void;
    };

export function WarehouseToggle(props: WarehouseToggleProps) {
  const { value, showAll } = props;
  const options: WarehouseSelection[] = showAll ? ["US", "CN", "All"] : ["US", "CN"];
  // The union narrows the prop callback per branch; in the narrow
  // branch only ["US", "CN"] are emitted by the loop, so calling the
  // narrow callback with the loop variable is safe at runtime. The
  // type system can't see that — assert through one common signature.
  const handleClick = props.onChange as (w: WarehouseSelection) => void;
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-neutral-300 bg-white">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => handleClick(o)}
          className={clsx(
            "px-3 py-1.5 text-sm font-medium",
            value === o
              ? "bg-neutral-900 text-white"
              : "text-neutral-700 hover:bg-neutral-100"
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
