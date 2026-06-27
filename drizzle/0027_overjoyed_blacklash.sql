ALTER TYPE "public"."source" ADD VALUE 'sheets_fb_geo' BEFORE 'shopify_us';--> statement-breakpoint
ALTER TYPE "public"."source" ADD VALUE 'sheets_fb_url_map' BEFORE 'shopify_us';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fb_ad_url_map" (
	"ad_id" text NOT NULL,
	"ad_name" text NOT NULL,
	"dest_url" text,
	"cost_usd" numeric(14, 4) NOT NULL,
	"source_pull_id" uuid NOT NULL,
	CONSTRAINT "fb_ad_url_map_ad_id_pk" PRIMARY KEY("ad_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fb_geo_spend" (
	"ad_id" text NOT NULL,
	"country_code" text NOT NULL,
	"cost_usd" numeric(14, 4) NOT NULL,
	"source_pull_id" uuid NOT NULL,
	CONSTRAINT "fb_geo_spend_ad_id_country_code_pk" PRIMARY KEY("ad_id","country_code")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fb_ad_url_map" ADD CONSTRAINT "fb_ad_url_map_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fb_geo_spend" ADD CONSTRAINT "fb_geo_spend_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
