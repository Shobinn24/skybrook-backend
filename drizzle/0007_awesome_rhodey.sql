CREATE TABLE IF NOT EXISTS "product_launches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_name" text NOT NULL,
	"shipment_name" text NOT NULL,
	"intl_site_live" date,
	"intl_launch_date" date,
	"us_site_live" date,
	"us_launch_date" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_launches_natural_uq" ON "product_launches" USING btree ("product_name","shipment_name");