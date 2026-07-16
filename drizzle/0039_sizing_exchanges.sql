CREATE TABLE IF NOT EXISTS "cs_exchanges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_year" integer NOT NULL,
	"row_date" date,
	"order_no" text NOT NULL,
	"email" text,
	"country" text,
	"process" text,
	"style_raw" text,
	"size_ordered_raw" text,
	"size_replaced_raw" text,
	"description" text,
	"amount" numeric(10, 2),
	"label" text,
	"size_ordered" text,
	"size_replaced" text,
	"direction" text,
	"excluded" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "size_chart_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"effective_date" date NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "variant_sales_monthly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store" text NOT NULL,
	"month" date NOT NULL,
	"label" text NOT NULL,
	"size" text NOT NULL,
	"units" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cs_exchanges_dedupe_uq" ON "cs_exchanges" USING btree ("order_no","size_ordered_raw","size_replaced_raw","description");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_exchanges_label_idx" ON "cs_exchanges" USING btree ("label");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "variant_sales_grain_uq" ON "variant_sales_monthly" USING btree ("store","month","label","size");