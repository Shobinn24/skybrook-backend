CREATE TABLE IF NOT EXISTS "supermetrics_query_state" (
	"label" text PRIMARY KEY NOT NULL,
	"tab_name" text NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
