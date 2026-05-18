CREATE TYPE "public"."factory_order_status" AS ENUM('draft', 'approved');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "factory_order_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"revenue_us" numeric(14, 2),
	"revenue_intl" numeric(14, 2),
	"revenue_amazon" numeric(14, 2),
	"forecast_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"splits_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scaling_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_qtys_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amazon_data_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"comments_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"order_notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_order_inputs_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "factory_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"destination" "location" NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost" numeric(10, 4) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"product_group" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "factory_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_month" date NOT NULL,
	"status" "factory_order_status" DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_orders_order_month_unique" UNIQUE("order_month")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factory_order_inputs" ADD CONSTRAINT "factory_order_inputs_order_id_factory_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."factory_orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factory_order_lines" ADD CONSTRAINT "factory_order_lines_order_id_factory_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."factory_orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "factory_order_lines_order_sku_dest_uq" ON "factory_order_lines" USING btree ("order_id","sku","destination");