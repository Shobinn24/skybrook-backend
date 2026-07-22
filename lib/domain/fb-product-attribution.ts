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
  // Intl launch 2026-07-10: Men's Brief ads open with a two-word product
  // token ("Men Brief ..."), so it's matched on the full prefix text before
  // the first-token dispatch below ("men"/"mens" alone still means Mens).
  if (/^mens? brief(\s|$)/i.test(raw)) return { product: "Mens Brief", bucket: "product" };
  // Intl launch 2026-07 wave 2: Men's Boxer (ev-flyboxer) gets its own
  // line, same two-word-token pattern as Men Brief.
  if (/^mens? boxer(\s|$)/i.test(raw)) return { product: "Mens Boxer", bucket: "product" };
  const p = raw.split(/\s+/)[0]?.toLowerCase() ?? "";
  const hf = /(^|\s)hf(\s|$)/i.test(raw) || p === "oghf" || p === "hwhf";
  const v = (base: string): FbAttribution => ({
    product: hf ? `${base} HF` : base,
    bucket: "product",
  });

  // "Homepage" = "Home" (marketer decision 2026-07-20: homepage BAU spend
  // is brand traffic, deliberately not mapped to any single product).
  if (p === "home" || p === "homepage")
    return { product: "Brand / Homepage", bucket: "brand" };
  if (p === "clearance") return { product: "Clearance / Mixed", bucket: "clearance" };
  if (p === "9055") return v("9055");
  if (p === "hw" || p === "hwhf") return v("HW");
  // Boyshort lumps regular + HF into one family (2026-06-26): the landing
  // URL offers both regular and heavy-flow as purchase options, so splitting
  // by ad name is meaningless. Unlike 9055/HW/etc, Boyshort ignores the HF flag.
  if (p === "bshort" || p === "boyshort") return { product: "Boyshort", bucket: "product" };
  if (p === "mens") return { product: "Mens", bucket: "product" }; // Mens + Mens BB merged; no HF line
  if (p === "suphw") return v("Super High-Waist");
  if (p === "shape") return v("Shapewear");
  if (p === "hrs") return { product: "High Rise Short", bucket: "product" };
  if (p === "og" || p === "oghf") return v("OG");
  // Intl launch 2026-07-10: "Cotton" = the Cotton 9055 line (ev-cottonhip
  // "Cotton Hipster"). Cotton HW deliberately gets its own "CHW" token so
  // "Cotton" stays unambiguous (marketer decision 2026-07-10).
  if (p === "cotton") return { product: "Cotton 9055", bucket: "product" };
  if (p === "chw") return { product: "Cotton HW", bucket: "product" };
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

// Normalize a destination URL into the stable lookup key used by the
// Jasper-maintained product map sheet (fb_product_map). Host is kept (so
// shop.everdries.com stays distinct from everdries.com — the funnel/region
// signal), `www.` and scheme/query/hash are dropped, path is lowercased and
// de-trailing-slashed. Social permalinks (facebook/instagram) never name a
// landing page -> null. Unparseable -> null. Root "/" -> host only.
const SOCIAL_HOST_RE = /(^|\.)(facebook\.com|fb\.me|instagram\.com)$/;
export function normalizeFunnelUrl(raw: string | null | undefined): string | null {
  const u = (raw ?? "").trim();
  if (!u) return null;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  if (SOCIAL_HOST_RE.test(host)) return null;
  const path = url.pathname.toLowerCase().replace(/\/+$/, "");
  return path ? `${host}${path}` : host;
}

// Map a product label as typed in the sheet onto its canonical family label +
// bucket kind. Special labels (Home/Clearance/NA) become the existing spend-only
// buckets; "Super HW" aligns to the revenue family "Super High-Waist"; every
// other label (known or brand-new) passes through as a product so Jasper can add
// a line by just typing it in the sheet. Blank or "NA" -> intentionally-mapped
// "Other (NA)" bucket (NOT flagged by the missing-links check).
export function canonicalProductLabel(
  sheetLabel: string | null | undefined,
): { label: string; kind: FbBucket } {
  const raw = (sheetLabel ?? "").trim();
  const key = raw.toLowerCase();
  if (key === "" || key === "na") return { label: "Other (NA)", kind: "unmapped" };
  if (key === "home" || key === "homepage")
    return { label: "Brand / Homepage", kind: "brand" };
  if (key === "clearance") return { label: "Clearance / Mixed", kind: "clearance" };
  if (key === "super hw") return { label: "Super High-Waist", kind: "product" };
  // Intl launch 2026-07-10: pin the plausible sheet spellings of the two new
  // lines (+ future Cotton HW) onto one canonical label each, so the sheet
  // and the ad-name fallback can never split one product into near-duplicate
  // rows ("Men Brief" vs "Mens Brief").
  if (key === "cotton" || key === "cotton 9055" || key === "cotton hipster")
    return { label: "Cotton 9055", kind: "product" };
  if (key === "chw" || key === "cotton hw") return { label: "Cotton HW", kind: "product" };
  if (key === "men brief" || key === "mens brief" || key === "men's brief")
    return { label: "Mens Brief", kind: "product" };
  if (
    key === "men boxer" ||
    key === "mens boxer" ||
    key === "men's boxer" ||
    key === "boxer" ||
    key === "boxer brief" ||
    key === "mens boxer brief"
  )
    return { label: "Mens Boxer", kind: "product" };
  return { label: raw, kind: "product" };
}

// Return the path of an everdries.com destination URL, or null when the URL is
// not an everdries page (facebook video permalink, advertorial domain, blank,
// or unparseable). Null => the caller should fall back to ad-name attribution.
export function extractEverdriesPath(destUrl: string | null | undefined): string | null {
  const u = (destUrl ?? "").trim();
  if (!u) return null;
  let host: string;
  let path: string;
  try {
    const url = new URL(u);
    host = url.hostname.toLowerCase();
    path = url.pathname;
  } catch {
    return null;
  }
  if (!host.includes("everdries")) return null;
  return path;
}

// Attribute a FB ad to a product family from its DESTINATION URL — the most
// accurate signal, since ad names are sometimes wrong (Jasper 2026-06-26). The
// URL is the coalesced landing page (Promoted post -> External -> catch-all
// destination URL). Returns null when the URL names no product, so the caller
// falls back to the ad-name prefix (attributeFbPrefix):
//   - non-everdries host (facebook permalink, advertorial domain) -> null
//   - advertorials / editorial pages (listicles, /pages/...) -> null
//   - homepage "/" -> Brand / Homepage
//
// JASPER'S FUNNEL RULES (trusted, 2026-06-27, validated 100% per-ad vs their FB
// report): /comfort & /comfortplus = the 9055 line; heavy-flow OG/HW pages AND
// all free-gift pages actually sell 9055 HF. Keep this ordering — earlier rules
// win (e.g. /heavyflow-og is 9055 HF, not OG).
export function attributeUrlProduct(destUrl: string | null | undefined): FbAttribution | null {
  const rawPath = extractEverdriesPath(destUrl);
  if (rawPath === null) return null;
  const p = rawPath.toLowerCase().replace(/\/+$/, "");
  if (p === "" || p === "/") return { product: "Brand / Homepage", bucket: "brand" };

  const product = (base: string): FbAttribution => ({ product: base, bucket: "product" });
  const nineHf = (): FbAttribution => product("9055 HF");

  // Advertorials / editorial pages name no product -> ad-name fallback.
  if (/(listicle|live-?freely|leakproof-(panties|underwear)|reasons|postpartum|nighttime|^\/?pages\/)/.test(p)) {
    return null;
  }
  // Jasper: heavy-flow OG/HW pages and all free-gift pages funnel to 9055 HF.
  if (p.includes("heavyflow") && (p.includes("og") || p.includes("hw"))) return nineHf();
  if (p.includes("gift")) return nineHf();
  // /comfort, /comfortplus, /comfort-* = the 9055 line (/heavyflow-comfort = HF).
  if (p.includes("comfort")) return p.includes("heavyflow") ? nineHf() : product("9055");
  if (p.includes("boyshort")) return product("Boyshort"); // HF lumped (see attributeFbPrefix)
  if (p.includes("shapewear")) return product("Shapewear");
  if (p.includes("superhw") || p.includes("highwaist")) return product("Super High-Waist");
  if (p.includes("highrise") || p.includes("high-rise")) return product("High Rise Short");
  if (p.includes("lavender") || p.includes("og")) return product("OG");
  if (/\bhw\b/.test(p) || p.includes("heavyflow")) return product("HW");
  if (/(mens|boxer|brief|men-)/.test(p)) return product("Mens");
  if (p.includes("clearance")) return { product: "Clearance / Mixed", bucket: "clearance" };
  return null;
}
