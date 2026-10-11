CREATE TABLE "outbound_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"requested_by_membership_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"message_type" text NOT NULL,
	"template_id" uuid,
	"recipient_kind" text NOT NULL,
	"recipient_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"hold_reason" text,
	"failure_code" text,
	"provider_http_status" integer,
	"provider_error_code" text,
	"provider_message_status" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_deadline" timestamp with time zone NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"send_started_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_requests_idempotency_unique" UNIQUE("organization_id","whatsapp_account_id","requested_by_membership_id","idempotency_key"),
	CONSTRAINT "outbound_requests_org_message_unique" UNIQUE("organization_id","message_id"),
	CONSTRAINT "outbound_requests_state_check" CHECK ("outbound_requests"."state" IN ('QUEUED', 'SENDING', 'ACCEPTED', 'REJECTED', 'HELD', 'UNKNOWN_OUTCOME')),
	CONSTRAINT "outbound_requests_type_check" CHECK ("outbound_requests"."message_type" IN ('TEXT', 'TEMPLATE')),
	CONSTRAINT "outbound_requests_recipient_kind_check" CHECK ("outbound_requests"."recipient_kind" IN ('PHONE', 'BSUID')),
	CONSTRAINT "outbound_requests_idempotency_key_check" CHECK (char_length("outbound_requests"."idempotency_key") BETWEEN 8 AND 128 AND "outbound_requests"."idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
	CONSTRAINT "outbound_requests_fingerprint_check" CHECK ("outbound_requests"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "outbound_requests_recipient_id_check" CHECK (char_length("outbound_requests"."recipient_id") BETWEEN 1 AND 255),
	CONSTRAINT "outbound_requests_attempts_check" CHECK ("outbound_requests"."attempt_count" BETWEEN 0 AND 20),
	CONSTRAINT "outbound_requests_codes_check" CHECK (("outbound_requests"."hold_reason" IS NULL OR "outbound_requests"."hold_reason" ~ '^[a-z0-9_]{1,64}$')
        AND ("outbound_requests"."failure_code" IS NULL OR "outbound_requests"."failure_code" ~ '^[a-z0-9_]{1,64}$')
        AND ("outbound_requests"."provider_error_code" IS NULL OR char_length("outbound_requests"."provider_error_code") <= 64)
        AND ("outbound_requests"."provider_message_status" IS NULL OR char_length("outbound_requests"."provider_message_status") <= 64)),
	CONSTRAINT "outbound_requests_template_check" CHECK (("outbound_requests"."message_type" = 'TEMPLATE') = ("outbound_requests"."template_id" IS NOT NULL)),
	CONSTRAINT "outbound_requests_lifecycle_check" CHECK (("outbound_requests"."state" <> 'HELD' OR "outbound_requests"."hold_reason" IS NOT NULL)
        AND ("outbound_requests"."state" <> 'REJECTED' OR "outbound_requests"."failure_code" IS NOT NULL)
        AND ("outbound_requests"."state" <> 'SENDING' OR ("outbound_requests"."claimed_by" IS NOT NULL AND "outbound_requests"."send_started_at" IS NOT NULL))
        AND ("outbound_requests"."state" <> 'QUEUED' OR "outbound_requests"."claimed_by" IS NULL)
        AND ("outbound_requests"."state" <> 'ACCEPTED' OR ("outbound_requests"."accepted_at" IS NOT NULL AND "outbound_requests"."send_started_at" IS NOT NULL))
        AND ("outbound_requests"."state" <> 'UNKNOWN_OUTCOME' OR "outbound_requests"."send_started_at" IS NOT NULL)
        AND ("outbound_requests"."state" NOT IN ('ACCEPTED', 'REJECTED', 'HELD', 'UNKNOWN_OUTCOME') OR "outbound_requests"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"whatsapp_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language_code" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'PENDING_ATTESTATION' NOT NULL,
	"body_parameter_count" smallint DEFAULT 0 NOT NULL,
	"attested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_templates_org_account_name_lang_unique" UNIQUE("organization_id","whatsapp_account_id","name","language_code"),
	CONSTRAINT "whatsapp_templates_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "whatsapp_templates_org_id_account_unique" UNIQUE("organization_id","id","whatsapp_account_id"),
	CONSTRAINT "whatsapp_templates_name_check" CHECK (char_length("whatsapp_templates"."name") BETWEEN 1 AND 512 AND "whatsapp_templates"."name" ~ '^[a-z0-9_]+$'),
	CONSTRAINT "whatsapp_templates_language_check" CHECK ("whatsapp_templates"."language_code" ~ '^[a-z]{2,3}(_[A-Za-z]{2,4})?$'),
	CONSTRAINT "whatsapp_templates_category_check" CHECK ("whatsapp_templates"."category" IN ('UTILITY', 'MARKETING', 'AUTHENTICATION')),
	CONSTRAINT "whatsapp_templates_status_check" CHECK ("whatsapp_templates"."status" IN ('PENDING_ATTESTATION', 'APPROVED', 'DISABLED')),
	CONSTRAINT "whatsapp_templates_params_check" CHECK ("whatsapp_templates"."body_parameter_count" BETWEEN 0 AND 20),
	CONSTRAINT "whatsapp_templates_attested_check" CHECK ("whatsapp_templates"."status" <> 'APPROVED' OR "whatsapp_templates"."attested_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_org_account_fk" FOREIGN KEY ("organization_id","whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_org_conversation_account_fk" FOREIGN KEY ("organization_id","conversation_id","whatsapp_account_id") REFERENCES "public"."conversations"("organization_id","id","whatsapp_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_org_message_account_fk" FOREIGN KEY ("organization_id","message_id","whatsapp_account_id") REFERENCES "public"."messages"("organization_id","id","whatsapp_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_org_member_fk" FOREIGN KEY ("organization_id","requested_by_membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_requests" ADD CONSTRAINT "outbound_requests_org_template_account_fk" FOREIGN KEY ("organization_id","template_id","whatsapp_account_id") REFERENCES "public"."whatsapp_templates"("organization_id","id","whatsapp_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_org_account_fk" FOREIGN KEY ("organization_id","whatsapp_account_id") REFERENCES "public"."whatsapp_accounts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_requests_queue_idx" ON "outbound_requests" USING btree ("next_attempt_at","id") WHERE "outbound_requests"."state" = 'QUEUED';--> statement-breakpoint
CREATE INDEX "outbound_requests_sending_idx" ON "outbound_requests" USING btree ("send_started_at") WHERE "outbound_requests"."state" = 'SENDING';--> statement-breakpoint
CREATE INDEX "outbound_requests_state_idx" ON "outbound_requests" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "outbound_requests_account_send_idx" ON "outbound_requests" USING btree ("whatsapp_account_id","send_started_at" DESC NULLS LAST) WHERE "outbound_requests"."send_started_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbound_requests_conversation_idx" ON "outbound_requests" USING btree ("organization_id","conversation_id","created_at");
--> statement-breakpoint
-- The lifecycle guard (hand-written; Drizzle does not model triggers). It makes the two safety properties of outbound sending
-- database guarantees rather than application conventions:
--  1. what was asked (organization, account, conversation, message, requester, key, fingerprint, type, template, recipient,
--     payload, deadline) can never change after the request exists;
--  2. ACCEPTED, REJECTED, HELD and UNKNOWN_OUTCOME are final. In particular an UNKNOWN_OUTCOME request can never go back to
--     QUEUED: whatever the application does, PostgreSQL refuses to make a possibly-sent message sendable again.
-- Allowed moves: QUEUED -> SENDING | HELD, and SENDING -> ACCEPTED | REJECTED | UNKNOWN_OUTCOME | HELD | QUEUED (QUEUED only
-- when the application can prove the request never left the process).
CREATE FUNCTION outbound_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.whatsapp_account_id IS DISTINCT FROM OLD.whatsapp_account_id
		OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
		OR NEW.message_id IS DISTINCT FROM OLD.message_id
		OR NEW.requested_by_membership_id IS DISTINCT FROM OLD.requested_by_membership_id
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
		OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
		OR NEW.message_type IS DISTINCT FROM OLD.message_type
		OR NEW.template_id IS DISTINCT FROM OLD.template_id
		OR NEW.recipient_kind IS DISTINCT FROM OLD.recipient_kind
		OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
		OR NEW.payload IS DISTINCT FROM OLD.payload
		OR NEW.dispatch_deadline IS DISTINCT FROM OLD.dispatch_deadline
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'outbound_requests: the request itself is immutable' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
		(OLD.state = 'QUEUED' AND NEW.state IN ('SENDING', 'HELD'))
		OR (OLD.state = 'SENDING' AND NEW.state IN ('ACCEPTED', 'REJECTED', 'UNKNOWN_OUTCOME', 'HELD', 'QUEUED'))
	) THEN
		RAISE EXCEPTION 'outbound_requests: illegal state change % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER outbound_requests_guard_trg BEFORE UPDATE ON "outbound_requests" FOR EACH ROW EXECUTE FUNCTION outbound_requests_guard();
