CREATE TABLE "contact_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"evidence" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_consents_scope_check" CHECK ("contact_consents"."scope" IN ('MARKETING')),
	CONSTRAINT "contact_consents_action_check" CHECK ("contact_consents"."action" IN ('GRANTED', 'WITHDRAWN')),
	CONSTRAINT "contact_consents_source_check" CHECK ("contact_consents"."source" IN ('META_AD', 'WHATSAPP_FORM', 'WEBSITE_FORM', 'STAFF_RECORDED', 'IMPORT_WITH_PROOF'))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"wa_id" text NOT NULL,
	"phone_e164" text,
	"profile_name" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"marketing_consent_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"marketing_consent_updated_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "contacts_org_wa_id_unique" UNIQUE("organization_id","wa_id"),
	CONSTRAINT "contacts_marketing_consent_status_check" CHECK ("contacts"."marketing_consent_status" IN ('UNKNOWN', 'GRANTED', 'WITHDRAWN'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_phone_number" text NOT NULL,
	"verified_name" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"credential_ref" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_accounts_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "whatsapp_accounts_status_check" CHECK ("whatsapp_accounts"."status" IN ('PENDING', 'ACTIVE', 'DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"organization_id" uuid,
	"whatsapp_account_id" uuid,
	"event_type" text NOT NULL,
	"provider_object_id" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "webhook_events_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "webhook_events_routing_check" CHECK (("webhook_events"."organization_id" IS NULL) = ("webhook_events"."whatsapp_account_id" IS NULL)),
	CONSTRAINT "webhook_events_status_check" CHECK ("webhook_events"."status" IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD', 'UNROUTABLE', 'IGNORED'))
);
--> statement-breakpoint
CREATE TABLE "webhook_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "conversations_org_id_account_unique" UNIQUE("organization_id","id","whatsapp_account_id"),
	CONSTRAINT "conversations_org_account_contact_unique" UNIQUE("organization_id","whatsapp_account_id","contact_id"),
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" IN ('OPEN', 'PENDING', 'RESOLVED'))
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"meta_media_id" text,
	"mime_type" text,
	"size_bytes" bigint,
	"filename" text,
	"sha256" text,
	"storage_key" text,
	"storage_status" text DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_message_media_unique" UNIQUE("message_id","meta_media_id"),
	CONSTRAINT "message_attachments_storage_status_check" CHECK ("message_attachments"."storage_status" IN ('PENDING', 'STORED', 'FAILED', 'EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE "message_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"message_id" uuid,
	"wamid" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"error_code" text,
	"error_message" text,
	"webhook_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_status_events_dedupe_unique" UNIQUE("whatsapp_account_id","wamid","status","occurred_at"),
	CONSTRAINT "message_status_events_status_check" CHECK ("message_status_events"."status" IN ('SENT', 'FAILED', 'DELIVERED', 'READ'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"wamid" text,
	"direction" text NOT NULL,
	"type" text NOT NULL,
	"body" text,
	"content" jsonb,
	"reply_to_message_id" uuid,
	"reply_to_wamid" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"latest_status" text,
	"latest_status_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"client_request_id" text,
	"source_webhook_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "messages_org_conversation_id_unique" UNIQUE("organization_id","conversation_id","id"),
	CONSTRAINT "messages_org_id_account_unique" UNIQUE("organization_id","id","whatsapp_account_id"),
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" IN ('INBOUND', 'OUTBOUND')),
	CONSTRAINT "messages_latest_status_check" CHECK ("messages"."latest_status" IS NULL OR "messages"."latest_status" IN ('SENT', 'FAILED', 'DELIVERED', 'READ'))
);
--> statement-breakpoint
CREATE TABLE "lead_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"message_id" uuid,
	"source_type" text NOT NULL,
	"source_id" text,
	"source_url" text,
	"headline" text,
	"body" text,
	"media_type" text,
	"media_url" text,
	"ctwa_clid" text,
	"provider_data" jsonb,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_attributions_source_type_check" CHECK ("lead_attributions"."source_type" IN ('META_AD', 'FACEBOOK_AD', 'INSTAGRAM_AD', 'ORGANIC_WHATSAPP', 'WEBSITE', 'QR_CODE', 'MANUAL', 'REFERRAL'))
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "leads_org_id_contact_unique" UNIQUE("organization_id","id","contact_id"),
	CONSTRAINT "leads_status_check" CHECK ("leads"."status" IN ('NEW', 'QUALIFIED', 'INTERESTED', 'REGISTRATION_STARTED', 'REGISTERED', 'PAID', 'CONVERTED', 'NOT_INTERESTED', 'NO_RESPONSE', 'INVALID'))
);
--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_tags_pk" PRIMARY KEY("organization_id","contact_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text GENERATED ALWAYS AS (lower(btrim(name))) STORED NOT NULL,
	"color" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tags_org_name_key_unique" UNIQUE("organization_id","name_key")
);
--> statement-breakpoint
ALTER TABLE "contact_consents" ADD CONSTRAINT "contact_consents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consents" ADD CONSTRAINT "contact_consents_org_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_accounts" ADD CONSTRAINT "whatsapp_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_request_id_webhook_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."webhook_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_org_account_fk" FOREIGN KEY ("organization_id","whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_account_fk" FOREIGN KEY ("organization_id","whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_org_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_org_account_fk" FOREIGN KEY ("organization_id","whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_org_message_account_fk" FOREIGN KEY ("organization_id","message_id","whatsapp_account_id") REFERENCES "public"."messages"("organization_id","id","whatsapp_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status_events" ADD CONSTRAINT "message_status_events_org_webhook_event_fk" FOREIGN KEY ("organization_id","webhook_event_id") REFERENCES "public"."webhook_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_source_webhook_event_fk" FOREIGN KEY ("organization_id","source_webhook_event_id") REFERENCES "public"."webhook_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_conversation_account_fk" FOREIGN KEY ("organization_id","conversation_id","whatsapp_account_id") REFERENCES "public"."conversations"("organization_id","id","whatsapp_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_same_conversation_fk" FOREIGN KEY ("organization_id","conversation_id","reply_to_message_id") REFERENCES "public"."messages"("organization_id","conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_attributions" ADD CONSTRAINT "lead_attributions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_attributions" ADD CONSTRAINT "lead_attributions_org_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_attributions" ADD CONSTRAINT "lead_attributions_org_lead_contact_fk" FOREIGN KEY ("organization_id","lead_id","contact_id") REFERENCES "public"."leads"("organization_id","id","contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_attributions" ADD CONSTRAINT "lead_attributions_org_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_org_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_org_tag_fk" FOREIGN KEY ("organization_id","tag_id") REFERENCES "public"."tags"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_consents_contact_scope_idx" ON "contact_consents" USING btree ("organization_id","contact_id","scope","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "contacts_org_last_seen_idx" ON "contacts" USING btree ("organization_id","last_seen_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_accounts_phone_number_id_uidx" ON "whatsapp_accounts" USING btree ("phone_number_id");--> statement-breakpoint
CREATE INDEX "webhook_events_queue_idx" ON "webhook_events" USING btree ("next_attempt_at") WHERE "webhook_events"."status" IN ('PENDING', 'FAILED');--> statement-breakpoint
CREATE INDEX "webhook_events_lease_idx" ON "webhook_events" USING btree ("locked_at") WHERE "webhook_events"."status" = 'PROCESSING';--> statement-breakpoint
CREATE INDEX "webhook_events_request_idx" ON "webhook_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_received_idx" ON "webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_org_received_idx" ON "webhook_events" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_requests_received_at_idx" ON "webhook_requests" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "conversations_inbox_idx" ON "conversations" USING btree ("organization_id","status","last_message_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "conversations_account_inbox_idx" ON "conversations" USING btree ("organization_id","whatsapp_account_id","last_message_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "conversations_org_contact_idx" ON "conversations" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "message_attachments_org_message_idx" ON "message_attachments" USING btree ("organization_id","message_id");--> statement-breakpoint
CREATE INDEX "message_attachments_pending_idx" ON "message_attachments" USING btree ("storage_status") WHERE "message_attachments"."storage_status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "message_status_events_message_idx" ON "message_status_events" USING btree ("message_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_wamid_uidx" ON "messages" USING btree ("organization_id","whatsapp_account_id","wamid") WHERE "messages"."wamid" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_request_uidx" ON "messages" USING btree ("organization_id","client_request_id") WHERE "messages"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_timeline_idx" ON "messages" USING btree ("conversation_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "lead_attributions_contact_idx" ON "lead_attributions" USING btree ("organization_id","contact_id","received_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "lead_attributions_source_idx" ON "lead_attributions" USING btree ("organization_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "leads_org_contact_idx" ON "leads" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "leads_org_status_idx" ON "leads" USING btree ("organization_id","status","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "contact_tags_tag_idx" ON "contact_tags" USING btree ("organization_id","tag_id","contact_id");