CREATE TABLE IF NOT EXISTS "incoming_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_name" text NOT NULL,
	"destination" "location" NOT NULL,
	"expected_arrival" date NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incoming_receipts_natural_uq" ON "incoming_receipts" USING btree ("shipment_name","destination","expected_arrival");