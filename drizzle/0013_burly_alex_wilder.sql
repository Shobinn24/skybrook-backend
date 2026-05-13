CREATE TYPE "public"."bonus_status" AS ENUM('pending', 'approved_full', 'approved_half', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."bonus_tier" AS ENUM('tier1', 'tier2');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bonus_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_number" text NOT NULL,
	"marketer" text NOT NULL,
	"tier" "bonus_tier" NOT NULL,
	"crossed_at" date NOT NULL,
	"status" "bonus_status" DEFAULT 'pending' NOT NULL,
	"amount_usd" numeric(10, 2) NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"notification_batch_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bonus_notification_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_label" text NOT NULL,
	"message_body" text NOT NULL,
	"totals_json" jsonb NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_by" text NOT NULL,
	"whatsapp_status" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bonus_awards_ad_marketer_tier_uq" ON "bonus_awards" USING btree ("ad_number","marketer","tier");