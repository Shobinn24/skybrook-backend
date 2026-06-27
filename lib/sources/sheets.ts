// Facade over lib/sources/sheets/*. This file used to hold all of the
// Google Sheets source code (~1,640 lines); it was split into focused
// modules on 2026-06-10 as pure code movement with zero behavior change.
// Every name previously exported from "@/lib/sources/sheets" is re-exported
// here so existing import sites keep working unchanged.
export * from "./sheets/client";
export * from "./sheets/parse-helpers";
export * from "./sheets/inventory";
export * from "./sheets/incoming";
export * from "./sheets/ad-spend";
export * from "./sheets/fb-ads";
export * from "./sheets/applovin";
export * from "./sheets/fb-geo-spend";
export * from "./sheets/fb-ad-url-map";
export * from "./sheets/bulk-order";
