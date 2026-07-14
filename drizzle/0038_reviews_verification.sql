CREATE TABLE IF NOT EXISTS "order_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store" text NOT NULL,
	"email" text NOT NULL,
	"product_id" text NOT NULL,
	"order_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loox_products" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "purchase_verified" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_emails_grain_uq" ON "order_emails" USING btree ("store","email","product_id","order_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_emails_email_idx" ON "order_emails" USING btree ("email");