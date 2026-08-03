ALTER TABLE "bonus_awards" ADD COLUMN "half_suggested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bonus_awards" ADD COLUMN "half_reason" text;
