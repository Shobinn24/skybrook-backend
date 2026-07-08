ALTER TYPE "public"."source" ADD VALUE IF NOT EXISTS 'sheets_launch_info' BEFORE 'shopify_us';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_info" (
	"product" text NOT NULL,
	"external_name" text,
	"pack_price_usd" numeric(10, 2),
	"colours" text,
	"main_composition" text,
	"liner_composition" text,
	"china_photoshoot_url" text,
	"image_tool_url" text,
	"source_pull_id" uuid NOT NULL,
	CONSTRAINT "launch_info_product_pk" PRIMARY KEY("product")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "launch_info" ADD CONSTRAINT "launch_info_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
