-- Add routed_location to daily_sales (Scott 2026-05-12 — fix US-store
-- international order routing). Existing rows: derive from channel
-- (shopify_us → US, shopify_intl → CN) so pre-fix behavior is preserved
-- on historical data. After this migration, the application code will
-- start writing the real ship-to routing for new pulls, and the
-- trailing-30d backfill will replace historical rows that need it.

ALTER TABLE "daily_sales"
  ADD COLUMN "routed_location" "location";

UPDATE "daily_sales"
SET "routed_location" = CASE
  WHEN "channel" = 'shopify_us'   THEN 'US'::location
  WHEN "channel" = 'shopify_intl' THEN 'CN'::location
END
WHERE "routed_location" IS NULL;

ALTER TABLE "daily_sales"
  ALTER COLUMN "routed_location" SET NOT NULL;

ALTER TABLE "daily_sales"
  DROP CONSTRAINT "daily_sales_channel_sku_sales_date_pk";

ALTER TABLE "daily_sales"
  ADD CONSTRAINT "daily_sales_channel_routed_location_sku_sales_date_pk"
  PRIMARY KEY ("channel","routed_location","sku","sales_date");
