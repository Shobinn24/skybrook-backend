CREATE TABLE IF NOT EXISTS "acknowledged_checks" (
	"pattern" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"acked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
