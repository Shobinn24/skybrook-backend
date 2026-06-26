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

// Pull the inner text of the leading "(...)" from an ad name; "" if none.
// This is the variant prefix stored in fb_ad_spend_daily.ad_prefix (the
// product signal that survives the ingest's per-(ad_number, prefix) grain).
export function extractFbPrefix(adNameRaw: string): string {
  const m = adNameRaw.match(/^\(([^)]+)\)/);
  return m ? m[1].trim() : "";
}

// Attribute from the inner prefix text alone (e.g. "9055 CC", "HOME US BAU").
// This is the canonical mapping; `attributeFbAd` and the per-variant query
// paths (getAllProductsRollup, fb-prefix-check) both funnel through it so
// the rule lives in exactly one place.
export function attributeFbPrefix(prefixInner: string): FbAttribution {
  const raw = (prefixInner ?? "").trim();
  if (!raw) return { product: "Unmapped", bucket: "unmapped" };
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

export function attributeFbAd(adNameRaw: string): FbAttribution {
  return attributeFbPrefix(extractFbPrefix(adNameRaw));
}

// AppLovin ad names carry the product in a pipe-delimited segment, e.g.
//   "<hash>_<adnum> | 9055 | Raul x Applovin 37 | Multi"  -> 9055
//   "<hash>_<adnum> | HW Gifts | Craig Vid 239"           -> HW
//   "1816 | Clearance | Raul Vid 212"                     -> Clearance / Mixed
// The 2nd segment is the product (same vocabulary as the FB prefix), so we
// reuse attributeFbPrefix on it. Names with no pipe (e.g. third-party
// "3P_Ad1_EV_..." creatives) or an unrecognized segment ("Mar DOM") fall to
// Unmapped — same no-silent-correction posture as FB.
export function attributeAppLovinAd(adName: string): FbAttribution {
  const parts = (adName ?? "").split("|").map((s) => s.trim());
  if (parts.length < 2 || !parts[1]) return { product: "Unmapped", bucket: "unmapped" };
  return attributeFbPrefix(parts[1]);
}
