import { describe, it, expect } from "vitest";
import {
  attributeAppLovinAd,
  attributeFbAd,
  attributeUrlProduct,
  canonicalProductLabel,
  normalizeFunnelUrl,
} from "@/lib/domain/fb-product-attribution";

describe("normalizeFunnelUrl", () => {
  const cases: Array<[string, string | null]> = [
    ["https://everdries.com/comfortplus", "everdries.com/comfortplus"],
    ["http://www.everdries.com/boyshort", "everdries.com/boyshort"], // www stripped, scheme ignored
    ["https://everdries.com/", "everdries.com"], // trailing slash / root -> host only
    ["https://everdries.com", "everdries.com"],
    ["https://shop.everdries.com/comfortplus", "shop.everdries.com/comfortplus"], // shop. kept distinct
    ["http://shop.everdries.com/", "shop.everdries.com"],
    ["https://everdries.com/Comfort-Pastel", "everdries.com/comfort-pastel"], // lowercased
    ["https://everdries.com/comfort?utm=x#frag", "everdries.com/comfort"], // query/hash dropped
    ["https://www.womansdailynews.com/416-adv", "womansdailynews.com/416-adv"], // advertorial host kept
    // social permalinks -> null (never a landing page)
    ["https://www.facebook.com/1581/videos/1445", null],
    ["https://fb.me/abc", null],
    ["https://l.facebook.com/l.php?u=x", null],
    ["https://www.instagram.com/p/xyz", null],
    ["", null],
    ["not-a-url", null],
  ];
  it.each(cases)("%s -> %s", (raw, expected) => {
    expect(normalizeFunnelUrl(raw)).toBe(expected);
  });
});

describe("canonicalProductLabel", () => {
  it("maps sheet labels to canonical families with correct kind", () => {
    expect(canonicalProductLabel("Super HW")).toEqual({ label: "Super High-Waist", kind: "product" });
    expect(canonicalProductLabel("Home")).toEqual({ label: "Brand / Homepage", kind: "brand" });
    expect(canonicalProductLabel("Homepage")).toEqual({ label: "Brand / Homepage", kind: "brand" });
    expect(canonicalProductLabel("Clearance")).toEqual({ label: "Clearance / Mixed", kind: "clearance" });
    expect(canonicalProductLabel("NA")).toEqual({ label: "Other (NA)", kind: "unmapped" });
  });
  it("trims trailing spaces", () => {
    expect(canonicalProductLabel("OG ")).toEqual({ label: "OG", kind: "product" });
    expect(canonicalProductLabel("HW ")).toEqual({ label: "HW", kind: "product" });
  });
  it("pins the 2026-07-10 launch lines onto one canonical label each", () => {
    expect(canonicalProductLabel("Cotton")).toEqual({ label: "Cotton 9055", kind: "product" });
    expect(canonicalProductLabel("Cotton Hipster")).toEqual({ label: "Cotton 9055", kind: "product" });
    expect(canonicalProductLabel("CHW")).toEqual({ label: "Cotton HW", kind: "product" });
    expect(canonicalProductLabel("Men Brief")).toEqual({ label: "Mens Brief", kind: "product" });
    expect(canonicalProductLabel("Men's Brief")).toEqual({ label: "Mens Brief", kind: "product" });
    expect(canonicalProductLabel("Men Boxer")).toEqual({ label: "Mens Boxer", kind: "product" });
    expect(canonicalProductLabel("Boxer Brief")).toEqual({ label: "Mens Boxer", kind: "product" });
  });
  it("passes through known + unknown product labels as kind product", () => {
    expect(canonicalProductLabel("9055")).toEqual({ label: "9055", kind: "product" });
    expect(canonicalProductLabel("9055 HF")).toEqual({ label: "9055 HF", kind: "product" });
    expect(canonicalProductLabel("Boyshort")).toEqual({ label: "Boyshort", kind: "product" });
    expect(canonicalProductLabel("High Rise Short")).toEqual({ label: "High Rise Short", kind: "product" });
    expect(canonicalProductLabel("Some New Line")).toEqual({ label: "Some New Line", kind: "product" });
  });
  it("blank -> unmapped Other (NA)", () => {
    expect(canonicalProductLabel("")).toEqual({ label: "Other (NA)", kind: "unmapped" });
  });
});

describe("attributeFbAd", () => {
  const cases: Array<[string, string, string]> = [
    // ad_name_raw,                                          product,             bucket
    ["(9055) Ad 2046 - Craig x Cat", "9055", "product"],
    ["(9055 CC) Ad 1631 - Dan Navarra", "9055", "product"],
    ["(9055 HF CC) Ad 2151 - Raul", "9055 HF", "product"],
    ["(9055 Pas CC) Ad 1 - pastel", "9055", "product"], // Pas != HF
    ["(BShort CC) Ad 2027 - Jacob", "Boyshort", "product"],
    // Boyshort + Boyshort HF are lumped into one family (2026-06-26): the
    // landing URL offers both regular and heavy-flow as purchase options, so
    // splitting spend/revenue by ad name is meaningless. Boyshort is the only
    // family with HF folded in; 9055/HW/etc still split.
    ["(Boyshort HF ASC) Ad 1770 - JW", "Boyshort", "product"],
    ["(Mens) Ad 2077 - Craig", "Mens", "product"],
    ["(Mens BB) Ad 2402 - Craig", "Mens", "product"], // merged, no HF line
    ["(SupHW INTL) Ad 2914 - GA", "Super High-Waist", "product"],
    ["(Shape SL CC) Ad 1 - Raul", "Shapewear", "product"],
    ["(HRS ICC) Ad 2936 - Craig", "High Rise Short", "product"],
    ["(HW HF) Ad 538 - Heavy Flow", "HW HF", "product"],
    ["(HWHF CC) Ad 893 - Nate", "HW HF", "product"],
    ["(OGHF ICC) Ad 648 - Raul", "OG HF", "product"],
    ["(OG Gifts CC) Ad 1 - x", "OG", "product"],
    // Intl launch 2026-07-10: Cotton = Cotton 9055 (ev-cottonhip), Men Brief
    // is a two-word product token, CHW reserved for Cotton HW so "Cotton"
    // stays unambiguous.
    ["(Cotton INTL) Ad 3001 - launch", "Cotton 9055", "product"],
    ["(Cotton) Ad 3002 - launch", "Cotton 9055", "product"],
    ["(CHW INTL) Ad 3050 - future", "Cotton HW", "product"],
    ["(Men Brief INTL) Ad 3003 - launch", "Mens Brief", "product"],
    ["(Mens Brief CC) Ad 3004 - variant spelling", "Mens Brief", "product"],
    // Intl launch 2026-07 wave 2: the boxer line, same token pattern
    ["(Men Boxer INTL) Ad 3100 - launch", "Mens Boxer", "product"],
    ["(Mens Boxer) Ad 3101 - variant spelling", "Mens Boxer", "product"],
    // "Mens BB" stays the classic Mens advertorial line, NOT the boxer
    ["(Mens BB) Ad 2402 - existing line", "Mens", "product"],
    ["(Mens) Ad 3005 - still plain Mens", "Mens", "product"],
    ["(HOME US BAU) Ad 1616 - Dan", "Brand / Homepage", "brand"],
    // "Homepage" = "Home" (marketer decision 2026-07-20: homepage BAU
    // spend is brand traffic, deliberately not mapped to a product)
    ["(Homepage US BAU) Ad 1700 - brand traffic", "Brand / Homepage", "brand"],
    ["(Homepage INT BAU) Ad 1701 - brand traffic", "Brand / Homepage", "brand"],
    ["(Clearance US BAU) Ad 1586 - Raul", "Clearance / Mixed", "clearance"],
    ["(Botshort CC) Ad 1 - typo", "Unmapped", "unmapped"], // typo -> alert, no auto-correct
    ["(LAV) Ad 1 - color only", "Unmapped", "unmapped"],
    ["no parens at all", "Unmapped", "unmapped"],
  ];
  it.each(cases)("%s -> %s/%s", (raw, product, bucket) => {
    const r = attributeFbAd(raw);
    expect(r.product).toBe(product);
    expect(r.bucket).toBe(bucket);
  });
});

describe("attributeAppLovinAd", () => {
  const cases: Array<[string, string, string]> = [
    // ad name (pipe-delimited),                                    product,            bucket
    ["0d38e8_698 | 9055 | Raul x Applovin 37 | Multi", "9055", "product"],
    ["0d38e8_1610 | HW Gifts | Craig Vid 239", "HW", "product"],
    ["1816 | Clearance | Raul Vid 212", "Clearance / Mixed", "clearance"],
    ["1424 | OG Gifts | Craig Vid 194 | Multi", "OG", "product"],
    ["932 | HW Gifts | Craig Free Gifts Vid 3 | EC14.2 | V2 MULTI", "HW", "product"],
    ["x | 9055 HF | y", "9055 HF", "product"],
    ["x | Boyshort | y", "Boyshort", "product"],
    ["x | Boyshort HF | y", "Boyshort", "product"], // HF lumped into Boyshort (2026-06-26)
    ["x | Mar DOM | y", "Unmapped", "unmapped"], // unrecognized segment
    ["3P_Ad1_EV_PadComparison60secs_Manticore_StaticConversion01", "Unmapped", "unmapped"], // no pipe
    ["", "Unmapped", "unmapped"],
  ];
  it.each(cases)("%s -> %s/%s", (name, product, bucket) => {
    const r = attributeAppLovinAd(name);
    expect(r.product).toBe(product);
    expect(r.bucket).toBe(bucket);
  });
});

describe("attributeUrlProduct", () => {
  // URL (with tracking query string) -> product family, or null (fall back to ad name).
  const cases: Array<[string, string | null]> = [
    // comfort / comfortplus = the 9055 line (confirmed vs Scott's URL column)
    ["https://everdries.com/comfortplus?nbt=x", "9055"],
    ["https://www.everdries.com/comfort", "9055"],
    ["https://everdries.com/comfort-pastel", "9055"],
    ["https://everdries.com/heavyflow-comfort", "9055 HF"],
    // JASPER: heavy-flow OG/HW + free gifts all funnel to 9055 HF
    ["https://everdries.com/heavyflow-og", "9055 HF"],
    ["https://everdries.com/heavyflow-og-int", "9055 HF"],
    ["https://everdries.com/heavyflow-hw", "9055 HF"],
    ["https://everdries.com/gifts-og", "9055 HF"],
    ["https://everdries.com/gifts-hw-int", "9055 HF"],
    ["https://everdries.com/freegifts", "9055 HF"],
    // straightforward product pages
    ["https://www.everdries.com/boyshort", "Boyshort"],
    ["https://everdries.com/heavyflow-boyshort", "Boyshort"], // HF lumped
    ["https://shop.everdries.com/shapewear", "Shapewear"],
    ["https://everdries.com/superhw", "Super High-Waist"],
    ["https://everdries.com/highrise-shorts", "High Rise Short"],
    ["https://everdries.com/lavender", "OG"],
    ["https://everdries.com/boxer-briefs-adv", "Mens"],
    ["https://everdries.com/mens", "Mens"],
    ["https://everdries.com/clearance", "Clearance / Mixed"],
    ["https://everdries.com/", "Brand / Homepage"],
    ["https://everdries.com", "Brand / Homepage"],
    // advertorials / editorial -> null (ad-name fallback)
    ["https://everdries.com/nighttime-listicle", null],
    ["https://everdries.com/live-freely", null],
    ["https://everdries.com/mens-incontinence", "Mens"], // names a product
    ["https://everdries.com/pages/8-reasons-women-ditching-pads", null],
    // non-everdries -> null (fall back to ad name)
    ["https://www.facebook.com/1581/videos/1445", null],
    ["https://www.facebook.com/reel/1485/", null],
    ["https://womansdailynews.com/some-advertorial", null],
    ["", null],
    ["not-a-url", null],
  ];
  it.each(cases)("%s -> %s", (url, expected) => {
    const r = attributeUrlProduct(url);
    expect(r === null ? null : r.product).toBe(expected);
  });

  it("tags homepage as brand bucket and products as product bucket", () => {
    expect(attributeUrlProduct("https://everdries.com/")?.bucket).toBe("brand");
    expect(attributeUrlProduct("https://everdries.com/comfortplus")?.bucket).toBe("product");
    expect(attributeUrlProduct("https://everdries.com/clearance")?.bucket).toBe("clearance");
  });
});
