-- Add country_code to AppLovin spend (defaults '' for legacy rows pulled before
-- the Country column existed), then swap the PK to include it. Order matters:
-- the column must exist before the new PK can reference it.
ALTER TABLE "applovin_ad_spend_daily" ADD COLUMN "country_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "applovin_ad_spend_daily" DROP CONSTRAINT "applovin_ad_spend_daily_product_spend_date_pk";--> statement-breakpoint
ALTER TABLE "applovin_ad_spend_daily" ADD CONSTRAINT "applovin_ad_spend_daily_product_country_code_spend_date_pk" PRIMARY KEY("product","country_code","spend_date");
