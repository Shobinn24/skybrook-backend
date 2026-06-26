CREATE TABLE IF NOT EXISTS "applovin_ad_spend_daily" (
	"product" text NOT NULL,
	"spend_date" date NOT NULL,
	"cost_usd" numeric(14, 4) NOT NULL,
	"source_pull_id" uuid NOT NULL,
	CONSTRAINT "applovin_ad_spend_daily_product_spend_date_pk" PRIMARY KEY("product","spend_date")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applovin_ad_spend_daily" ADD CONSTRAINT "applovin_ad_spend_daily_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
