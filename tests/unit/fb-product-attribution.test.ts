import { describe, it, expect } from "vitest";
import {
  attributeAppLovinAd,
  attributeFbAd,
} from "@/lib/domain/fb-product-attribution";

describe("attributeFbAd", () => {
  const cases: Array<[string, string, string]> = [
    // ad_name_raw,                                          product,             bucket
    ["(9055) Ad 2046 - Craig x Cat", "9055", "product"],
    ["(9055 CC) Ad 1631 - Dan Navarra", "9055", "product"],
    ["(9055 HF CC) Ad 2151 - Raul", "9055 HF", "product"],
    ["(9055 Pas CC) Ad 1 - pastel", "9055", "product"], // Pas != HF
    ["(BShort CC) Ad 2027 - Jacob", "Boyshort", "product"],
    ["(Boyshort HF ASC) Ad 1770 - JW", "Boyshort HF", "product"],
    ["(Mens) Ad 2077 - Craig", "Mens", "product"],
    ["(Mens BB) Ad 2402 - Craig", "Mens", "product"], // merged, no HF line
    ["(SupHW INTL) Ad 2914 - GA", "Super High-Waist", "product"],
    ["(Shape SL CC) Ad 1 - Raul", "Shapewear", "product"],
    ["(HRS ICC) Ad 2936 - Craig", "High Rise Short", "product"],
    ["(HW HF) Ad 538 - Heavy Flow", "HW HF", "product"],
    ["(HWHF CC) Ad 893 - Nate", "HW HF", "product"],
    ["(OGHF ICC) Ad 648 - Raul", "OG HF", "product"],
    ["(OG Gifts CC) Ad 1 - x", "OG", "product"],
    ["(HOME US BAU) Ad 1616 - Dan", "Brand / Homepage", "brand"],
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
