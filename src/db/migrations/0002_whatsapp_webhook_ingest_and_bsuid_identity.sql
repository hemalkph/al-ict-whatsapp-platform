CREATE TABLE "contact_bsuids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"bsuid" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"source_webhook_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_bsuids_org_bsuid_unique" UNIQUE("organization_id","bsuid"),
	CONSTRAINT "contact_bsuids_bsuid_check" CHECK (char_length("contact_bsuids"."bsuid") BETWEEN 1 AND 255),
	CONSTRAINT "contact_bsuids_seen_order_check" CHECK ("contact_bsuids"."last_seen_at" >= "contact_bsuids"."first_seen_at"),
	CONSTRAINT "contact_bsuids_retired_order_check" CHECK ("contact_bsuids"."retired_at" IS NULL OR "contact_bsuids"."retired_at" >= "contact_bsuids"."first_seen_at")
);
--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "wa_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "webhook_requests" ADD COLUMN "raw_body" "bytea" NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_requests" ADD COLUMN "ingest_status" text DEFAULT 'ACCEPTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_requests" ADD COLUMN "ingest_error_code" text;--> statement-breakpoint
ALTER TABLE "contact_bsuids" ADD CONSTRAINT "contact_bsuids_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_bsuids" ADD CONSTRAINT "contact_bsuids_org_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_bsuids" ADD CONSTRAINT "contact_bsuids_source_event_fk" FOREIGN KEY ("source_webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_bsuids_org_contact_idx" ON "contact_bsuids" USING btree ("organization_id","contact_id","last_seen_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "contact_bsuids_source_event_idx" ON "contact_bsuids" USING btree ("source_webhook_event_id") WHERE "contact_bsuids"."source_webhook_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_requests_not_accepted_idx" ON "webhook_requests" USING btree ("ingest_status","received_at") WHERE "webhook_requests"."ingest_status" <> 'ACCEPTED';--> statement-breakpoint
ALTER TABLE "webhook_requests" DROP COLUMN "raw_payload";--> statement-breakpoint
ALTER TABLE "webhook_requests" ADD CONSTRAINT "webhook_requests_sha256_check" CHECK ("webhook_requests"."payload_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "webhook_requests" ADD CONSTRAINT "webhook_requests_ingest_status_check" CHECK ("webhook_requests"."ingest_status" IN ('ACCEPTED', 'UNPARSEABLE', 'UNSUPPORTED_SHAPE', 'EVENTS_REJECTED'));--> statement-breakpoint
ALTER TABLE "webhook_requests" ADD CONSTRAINT "webhook_requests_ingest_error_check" CHECK (("webhook_requests"."ingest_status" = 'ACCEPTED') = ("webhook_requests"."ingest_error_code" IS NULL));--> statement-breakpoint
ALTER TABLE "webhook_requests" ADD CONSTRAINT "webhook_requests_ingest_error_len_check" CHECK ("webhook_requests"."ingest_error_code" IS NULL OR char_length("webhook_requests"."ingest_error_code") BETWEEN 1 AND 64);