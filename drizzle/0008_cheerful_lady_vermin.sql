CREATE TABLE IF NOT EXISTS "sku_family_overrides" (
	"family" text PRIMARY KEY NOT NULL,
	"display_label" text NOT NULL,
	"is_implicit_5pack" boolean DEFAULT false NOT NULL,
	"alias_of" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
