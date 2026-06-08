CREATE TYPE "public"."cashflow_category" AS ENUM('revenue_ev', 'revenue_jm', 'revenue_ewc', 'cogs_addback', 'profit_payout', 'bulk_order', 'ad_spend_google', 'ad_spend_meta', 'sales_tax', 'tax', 'payroll', 'whitelisting', 'software', 'tatari', 'agency', 'one_off');--> statement-breakpoint
CREATE TYPE "public"."cashflow_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."cashflow_kind" AS ENUM('forecast', 'actual');--> statement-breakpoint
CREATE TYPE "public"."cashflow_source" AS ENUM('manual', 'auto_revenue', 'auto_accrual', 'sheet_pull', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."cashflow_variance_reason" AS ENUM('volume', 'spending', 'timing');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cashflow_assumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ev_revenue_start" numeric(14, 2) DEFAULT '0' NOT NULL,
	"ev_weekly_growth" numeric(8, 4) DEFAULT '1' NOT NULL,
	"ev_net_margin" numeric(6, 4) DEFAULT '0' NOT NULL,
	"jm_revenue_start" numeric(14, 2) DEFAULT '0' NOT NULL,
	"jm_weekly_growth" numeric(8, 4) DEFAULT '1' NOT NULL,
	"jm_net_margin" numeric(6, 4) DEFAULT '0' NOT NULL,
	"ewc_revenue_start" numeric(14, 2) DEFAULT '0' NOT NULL,
	"ewc_weekly_growth" numeric(8, 4) DEFAULT '1' NOT NULL,
	"ewc_net_margin" numeric(6, 4) DEFAULT '0' NOT NULL,
	"cogs_pct" numeric(6, 4) DEFAULT '0.15' NOT NULL,
	"profit_payout_pct" numeric(6, 4) DEFAULT '0.90' NOT NULL,
	"variance_threshold_usd" numeric(14, 2) DEFAULT '30000' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cashflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "cashflow_kind" NOT NULL,
	"forecast_event_id" uuid,
	"category" "cashflow_category" NOT NULL,
	"direction" "cashflow_direction" NOT NULL,
	"amount_usd" numeric(14, 2) NOT NULL,
	"accrual_date" date NOT NULL,
	"cash_date" date NOT NULL,
	"source" "cashflow_source" NOT NULL,
	"source_ref" text,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cashflow_weekly" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" date NOT NULL,
	"actual_total_cash_usd" numeric(14, 2),
	"payout_override_usd" numeric(14, 2),
	"payout_skipped" boolean DEFAULT false NOT NULL,
	"variance_reason" "cashflow_variance_reason",
	"variance_note" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" text DEFAULT 'system' NOT NULL,
	CONSTRAINT "cashflow_weekly_week_start_unique" UNIQUE("week_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cashflow_events_source_ref_ux" ON "cashflow_events" USING btree ("source","source_ref") WHERE "cashflow_events"."source" <> 'manual' AND "cashflow_events"."source_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cashflow_events_cash_date_idx" ON "cashflow_events" USING btree ("cash_date");