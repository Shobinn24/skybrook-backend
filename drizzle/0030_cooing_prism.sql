CREATE TABLE IF NOT EXISTS "campaign_tracker_notes" (
	"week_start" date PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fb_campaign_daily" (
	"campaign_name" text NOT NULL,
	"spend_date" date NOT NULL,
	"cost_usd" numeric(14, 4) NOT NULL,
	"purchase_value_usd" numeric(14, 4) NOT NULL,
	"source_pull_id" uuid NOT NULL,
	CONSTRAINT "fb_campaign_daily_campaign_name_spend_date_pk" PRIMARY KEY("campaign_name","spend_date")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fb_campaign_daily" ADD CONSTRAINT "fb_campaign_daily_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
