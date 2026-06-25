-- Variant-grain FB ad spend: store one row per (ad_number, ad_prefix,
-- spend_date) so homepage/brand spend on a shared creative is no longer
-- absorbed into the dominant product bucket (HOME-undercount fix).
--
-- Order matters: add the column first, backfill ad_prefix from the
-- existing canonical ad_name_raw, THEN swap the primary key to include it.
-- Existing rows are one-per-(ad_number, spend_date), so after backfill
-- (ad_number, ad_prefix, spend_date) is still unique and the PK swap is safe.

ALTER TABLE "fb_ad_spend_daily" ADD COLUMN "ad_prefix" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "fb_ad_spend_daily"
  SET "ad_prefix" = COALESCE(TRIM(SUBSTRING("ad_name_raw" FROM '^\(([^)]+)\)')), '');--> statement-breakpoint
ALTER TABLE "fb_ad_spend_daily" DROP CONSTRAINT "fb_ad_spend_daily_ad_number_spend_date_pk";--> statement-breakpoint
ALTER TABLE "fb_ad_spend_daily" ADD CONSTRAINT "fb_ad_spend_daily_ad_number_ad_prefix_spend_date_pk" PRIMARY KEY("ad_number","ad_prefix","spend_date");
