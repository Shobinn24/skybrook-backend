CREATE TABLE IF NOT EXISTS "shipping_flag_first_seen" (
	"order_id" text NOT NULL,
	"check_type" text NOT NULL,
	"first_flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_flag_first_seen_order_id_check_type_pk" PRIMARY KEY("order_id","check_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shipping_stats_daily" (
	"snapshot_date" date PRIMARY KEY NOT NULL,
	"delivered_count" integer NOT NULL,
	"avg_fulfilment_hours" numeric(8, 2),
	"avg_transit_days" numeric(6, 2),
	"avg_total_days" numeric(6, 2),
	"transit_histogram" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
