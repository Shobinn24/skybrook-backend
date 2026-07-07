ALTER TABLE "product_launches" ADD COLUMN "selling_price_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "product_launches" ADD COLUMN "external_product_name" text;--> statement-breakpoint
ALTER TABLE "product_launches" ADD COLUMN "factory_content_url" text;--> statement-breakpoint
ALTER TABLE "product_launches" ADD COLUMN "image_tool_content_url" text;