CREATE TYPE "public"."channel" AS ENUM('shopify_us', 'shopify_intl');--> statement-breakpoint
CREATE TYPE "public"."flag" AS ENUM('healthy', 'watch', 'at_risk', 'overstocked');--> statement-breakpoint
CREATE TYPE "public"."incoming_status" AS ENUM('po', 'dispatched', 'in_transit', 'arrived');--> statement-breakpoint
CREATE TYPE "public"."location" AS ENUM('US', 'CN');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('open', 'fulfilled', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."pull_status" AS ENUM('success', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('sheets_inventory', 'sheets_incoming', 'shopify_us', 'shopify_intl');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_pulls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pull_batch_id" uuid NOT NULL,
	"source" "source" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "pull_status" NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"raw_pull_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "days_of_stock" (
	"sku" text NOT NULL,
	"location" "location" NOT NULL,
	"as_of_date" date NOT NULL,
	"velocity_window_days" integer NOT NULL,
	"days_of_stock" numeric(12, 2) NOT NULL,
	"source_refs" jsonb NOT NULL,
	CONSTRAINT "days_of_stock_sku_location_as_of_date_velocity_window_days_pk" PRIMARY KEY("sku","location","as_of_date","velocity_window_days")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incoming_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"destination" "location" NOT NULL,
	"shipment_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"expected_arrival" date NOT NULL,
	"status" "incoming_status" DEFAULT 'po' NOT NULL,
	"source_pull_id" uuid NOT NULL,
	"source_row_ref" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_pulls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "source" NOT NULL,
	"pulled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pull_batch_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"schema_fingerprint" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" "channel" NOT NULL,
	"source_order_id" text NOT NULL,
	"source_line_id" text NOT NULL,
	"sku" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_usd" numeric(12, 4) NOT NULL,
	"order_date_est" date NOT NULL,
	"fulfillment_date_est" date,
	"ship_to_country" text NOT NULL,
	"routed_location" "location" NOT NULL,
	"order_status" "order_status" NOT NULL,
	"refunded_at_est" date,
	"source_pull_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_velocity" (
	"sku" text NOT NULL,
	"channel" text NOT NULL,
	"window_days" integer NOT NULL,
	"as_of_date" date NOT NULL,
	"units_per_day" numeric(12, 4) NOT NULL,
	CONSTRAINT "sales_velocity_sku_channel_window_days_as_of_date_pk" PRIMARY KEY("sku","channel","window_days","as_of_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skus" (
	"sku" text PRIMARY KEY NOT NULL,
	"product_name" text NOT NULL,
	"product_line" text,
	"unit_cost_usd" numeric(12, 4),
	"first_seen_at" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_snapshots" (
	"sku" text NOT NULL,
	"location" "location" NOT NULL,
	"snapshot_date" date NOT NULL,
	"on_hand" integer NOT NULL,
	"source_pull_id" uuid NOT NULL,
	CONSTRAINT "stock_snapshots_sku_location_snapshot_date_pk" PRIMARY KEY("sku","location","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sustainability_flags" (
	"sku" text NOT NULL,
	"location" "location" NOT NULL,
	"as_of_date" date NOT NULL,
	"flag" "flag" NOT NULL,
	"reasoning" text NOT NULL,
	"run_out_date" date,
	"after_next_po_date" date,
	"source_refs" jsonb NOT NULL,
	CONSTRAINT "sustainability_flags_sku_location_as_of_date_pk" PRIMARY KEY("sku","location","as_of_date")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_pulls" ADD CONSTRAINT "data_pulls_raw_pull_id_raw_pulls_id_fk" FOREIGN KEY ("raw_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "incoming_shipments" ADD CONSTRAINT "incoming_shipments_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales_line_items" ADD CONSTRAINT "sales_line_items_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_line_items_channel_src_uq" ON "sales_line_items" USING btree ("channel","source_line_id");