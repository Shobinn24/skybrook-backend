CREATE TABLE IF NOT EXISTS "sheet_poll_state" (
	"source" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"last_modified_time" text,
	"last_checked_at" timestamp with time zone,
	"last_triggered_at" timestamp with time zone
);
