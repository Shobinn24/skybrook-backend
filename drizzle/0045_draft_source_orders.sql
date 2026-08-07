CREATE TABLE IF NOT EXISTS "draft_source_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store" text NOT NULL,
	"shopify_order_id" text NOT NULL,
	"order_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bonus_awards" ADD COLUMN IF NOT EXISTS "half_suggested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bonus_awards" ADD COLUMN IF NOT EXISTS "half_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "draft_source_orders_grain_uq" ON "draft_source_orders" USING btree ("store","shopify_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_source_orders_date_idx" ON "draft_source_orders" USING btree ("store","order_date");