DROP TABLE IF EXISTS "shopify_refunds_monthly";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopify_refund_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" text NOT NULL,
	"store" text NOT NULL,
	"refund_date" date NOT NULL,
	"label" text NOT NULL,
	"size" text NOT NULL,
	"units" integer NOT NULL,
	"amount_usd" numeric(14, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shopify_refund_lines_grain_uq" ON "shopify_refund_lines" ("refund_id","label","size");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_refund_lines_date_idx" ON "shopify_refund_lines" ("refund_date");
