// Derives a human-readable product name from a SKU code, used as a
// fallback when the velocity sheet hasn't supplied an explicit name.
//
// Format observed in Scott's velocity sheet (2026-04-28):
//   ev-{family}-{...modifiers...}-{size}
//
// Where modifiers can include any of: pack-size token (1x/5x/10x/15x),
// color (beige/black/fc), and HF (high-flow). Order varies — bshort
// puts color before HF before pack, og/hw put pack before color.
//
// Known families and their target shapes:
//   ev-9055-5x-*           → "Style 9055"   (canonical Boyshort 5-pack)
//   ev-9055-{10x|15x}-*    → "Style 9055 10-Pack" / "Style 9055 15-Pack"
//   ev-bshort-...          → "Boyshort [Color] [HF] [pack]"  (5-pack is implicit)
//   ev-og-1x-{color}-*     → "OG {Color} 1-Pack"
//   ev-og-{5x|10x|...}-*   → "OG [Color] {Pack}"
//   ev-hw-1x-{color}-*     → "HW {Color} 1-Pack"
//   ev-hw-{5x|10x|...}-*   → "HW [Color] {Pack}"
//
// Returns null when the SKU doesn't match a known family — caller should
// keep whatever name was already set (often the SKU itself as fallback).

const FAMILY_LABELS: Record<string, string> = {
  "9055": "Style 9055",
  "bshort": "Boyshort",
  "og": "OG",
  "hw": "HW",
};

const COLOR_LABELS: Record<string, string> = {
  beige: "Beige",
  black: "Black",
  fc: "FC",
};

const PACK_LABELS: Record<string, string> = {
  "1x": "1-Pack",
  "5x": "5-Pack",
  "10x": "10-Pack",
  "15x": "15-Pack",
};

export function deriveProductName(sku: string): string | null {
  const lower = sku.toLowerCase();
  const parts = lower.split("-");
  if (parts[0] !== "ev" || parts.length < 3) return null;

  const family = parts[1];
  // Last segment is size (xxs/xs/s/m/l/xl/xxl/2xl/3xl/4xl/5xl). Middle is modifiers.
  const middle = parts.slice(2, -1);

  let color: string | null = null;
  let pack: string | null = null;
  let hf = false;
  for (const t of middle) {
    if (COLOR_LABELS[t] && !color) color = COLOR_LABELS[t];
    else if (PACK_LABELS[t] && !pack) pack = PACK_LABELS[t];
    else if (t === "hf") hf = true;
  }

  switch (family) {
    case "9055": {
      // Default 5-pack: just "Style 9055"; non-default packs append the pack label.
      if (pack === "5-Pack" && !color && !hf) return "Style 9055";
      const out = ["Style 9055"];
      if (color) out.push(color);
      if (pack && pack !== "5-Pack") out.push(pack);
      if (hf) out.push("HF");
      return out.join(" ");
    }
    case "bshort": {
      // 5-pack is implicit for bshort; non-5-pack appends pack label.
      const out = ["Boyshort"];
      if (color) out.push(color);
      if (hf) out.push("HF");
      if (pack && pack !== "5-Pack") out.push(pack);
      return out.join(" ");
    }
    case "og":
    case "hw": {
      const out = [FAMILY_LABELS[family]];
      if (color) out.push(color);
      if (pack) out.push(pack);
      if (hf) out.push("HF");
      return out.join(" ");
    }
    default:
      return null;
  }
}
