CREATE TABLE IF NOT EXISTS "loox_products" (
	"handle" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"line" text,
	"include" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loox_reviews" ALTER COLUMN "email_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "loox_reviews" ALTER COLUMN "raw_text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "source" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "store" text;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "dedup_key" text;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "product_handle" text;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "reviewer_email" text;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "verified" boolean;--> statement-breakpoint
ALTER TABLE "loox_reviews" ADD COLUMN "status" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loox_reviews_store_external_id_uq" ON "loox_reviews" USING btree ("store","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loox_reviews_dedup_key_uq" ON "loox_reviews" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loox_reviews_product_handle_idx" ON "loox_reviews" USING btree ("product_handle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "loox_reviews_reviewed_at_idx" ON "loox_reviews" USING btree ("reviewed_at");