CREATE TABLE IF NOT EXISTS "velocity_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location" "location" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"multiplier" numeric(10, 4) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
