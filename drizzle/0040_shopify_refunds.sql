CREATE TABLE IF NOT EXISTS "shopify_refunds_monthly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store" text NOT NULL,
	"month" date NOT NULL,
	"label" text NOT NULL,
	"size" text NOT NULL,
	"units" integer NOT NULL,
	"amount_usd" numeric(14, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shopify_refunds_grain_uq" ON "shopify_refunds_monthly" USING btree ("store","month","label","size");