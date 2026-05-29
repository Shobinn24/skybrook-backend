ALTER TABLE "shipping_stats_daily" ADD COLUMN "fulfilment_flags" jsonb;--> statement-breakpoint
ALTER TABLE "shipping_stats_daily" ADD COLUMN "carrier_flags" jsonb;--> statement-breakpoint
ALTER TABLE "shipping_stats_daily" ADD COLUMN "flags_computed_at" timestamp with time zone;