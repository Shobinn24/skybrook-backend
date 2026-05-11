ALTER TYPE "public"."source" ADD VALUE 'sheets_fb_ads' BEFORE 'shopify_us';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fb_ad_spend_daily" (
	"ad_number" text NOT NULL,
	"ad_name" text NOT NULL,
	"ad_name_raw" text NOT NULL,
	"ad_link" text,
	"spend_date" date NOT NULL,
	"cost_usd" numeric(14, 4) NOT NULL,
	"source_pull_id" uuid NOT NULL,
	CONSTRAINT "fb_ad_spend_daily_ad_number_spend_date_pk" PRIMARY KEY("ad_number","spend_date")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fb_ad_spend_daily" ADD CONSTRAINT "fb_ad_spend_daily_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
