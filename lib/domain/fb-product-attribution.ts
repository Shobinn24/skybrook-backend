// Attribute a FB ad to a product family from the (PREFIX) at the start of
// ad_name_raw. Format: "(PRODUCT [variant] [funnel/region]) Ad NNN - ...".
// First token = product; CC/ICC/ASC/INTL/US BAU/ZOMB/ML/NL/Pas/Gifts/SL =
// campaign/region/offer modifiers; HF (or glued OGHF/HWHF) = heavy-flow split.
// HOME/Clearance = generic buckets. Anything else (typos, new products,
// abbreviations we haven't confirmed) -> "Unmapped" so the digest alert
// surfaces it.
//
// We deliberately do NOT auto-correct typos (decision 2026-06-25): the tool's
// correctness depends on correct ad naming, and that dependency must be
// visible (Unmapped bucket + alert), not silently papered over.

export type FbBucket = "product" | "brand" | "clearance" | "unmapped";
export type FbAttribution = { product: string; bucket: FbBucket };

export function attributeFbAd(adNameRaw: string): FbAttribution {
  const m = adNameRaw.match(/^\(([^)]+)\)/);
  if (!m) return { product: "Unmapped", bucket: "unmapped" };
  const raw = m[1].trim();
  const p = raw.split(/\s+/)[0]?.toLowerCase() ?? "";
  const hf = /(^|\s)hf(\s|$)/i.test(raw) || p === "oghf" || p === "hwhf";
  const v = (base: string): FbAttribution => ({
    product: hf ? `${base} HF` : base,
    bucket: "product",
  });

  if (p === "home") return { product: "Brand / Homepage", bucket: "brand" };
  if (p === "clearance") return { product: "Clearance / Mixed", bucket: "clearance" };
  if (p === "9055") return v("9055");
  if (p === "hw" || p === "hwhf") return v("HW");
  if (p === "bshort" || p === "boyshort") return v("Boyshort");
  if (p === "mens") return { product: "Mens", bucket: "product" }; // Mens + Mens BB merged; no HF line
  if (p === "suphw") return v("Super High-Waist");
  if (p === "shape") return v("Shapewear");
  if (p === "hrs") return { product: "High Rise Short", bucket: "product" };
  if (p === "og" || p === "oghf") return v("OG");
  return { product: "Unmapped", bucket: "unmapped" };
}
