ALTER TYPE "public"."source" ADD VALUE IF NOT EXISTS 'sheets_launch_info' BEFORE 'shopify_us';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loox_review_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_title" text NOT NULL,
	"review_count" integer NOT NULL,
	"avg_rating" numeric(3, 2),
	"analysis" jsonb NOT NULL,
	"model" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loox_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_message_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"product_title" text,
	"rating" integer,
	"reviewer_name" text,
	"review_text" text,
	"raw_text" text NOT NULL,
	"parsed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loox_reviews_email_message_id_uq" ON "loox_reviews" USING btree ("email_message_id");