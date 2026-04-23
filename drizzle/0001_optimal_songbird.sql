CREATE TABLE IF NOT EXISTS "daily_sales" (
	"channel" "channel" NOT NULL,
	"sku" text NOT NULL,
	"sales_date" date NOT NULL,
	"units_sold" integer NOT NULL,
	"net_sales_usd" numeric(14, 4) DEFAULT '0' NOT NULL,
	"source_pull_id" uuid NOT NULL,
	CONSTRAINT "daily_sales_channel_sku_sales_date_pk" PRIMARY KEY("channel","sku","sales_date")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_sales" ADD CONSTRAINT "daily_sales_source_pull_id_raw_pulls_id_fk" FOREIGN KEY ("source_pull_id") REFERENCES "public"."raw_pulls"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
