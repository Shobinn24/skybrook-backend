ALTER TYPE "public"."source" ADD VALUE 'sheets_fb_product_map' BEFORE 'shopify_us';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fb_product_map" (
	"normalized_url" text NOT NULL,
	"raw_url" text NOT NULL,
	"region" text NOT NULL,
	"product_label" text NOT NULL,
	"source_pull_id" uuid NOT NULL,
	CONSTRAINT "fb_product_map_normalized_url_pk" PRIMARY KEY("normalized_url")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fb_product_map" ADD CONSTRAINT "fb_product_map_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
