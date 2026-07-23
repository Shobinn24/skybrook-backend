CREATE TABLE IF NOT EXISTS "order_line_sizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store" text NOT NULL,
	"shopify_order_id" text NOT NULL,
	"email" text,
	"product_id" text NOT NULL,
	"product_title" text,
	"variant_title" text NOT NULL,
	"order_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN IF NOT EXISTS "loox_order_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_line_sizes_grain_uq" ON "order_line_sizes" USING btree ("store","shopify_order_id","product_id","variant_title");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_line_sizes_order_idx" ON "order_line_sizes" USING btree ("shopify_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_line_sizes_email_idx" ON "order_line_sizes" USING btree ("store","email","product_id");
