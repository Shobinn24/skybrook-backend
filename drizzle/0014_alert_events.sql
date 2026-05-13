CREATE TYPE "public"."alert_severity" AS ENUM('p0', 'p1', 'p2', 'p3');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedup_key" text NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"channel" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"slack_message_ts" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_events_open_by_key_uq" ON "alert_events" USING btree ("dedup_key") WHERE "alert_events"."resolved_at" IS NULL;