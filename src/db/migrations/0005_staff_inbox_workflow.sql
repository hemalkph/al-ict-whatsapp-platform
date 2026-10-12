CREATE TABLE "conversation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"from_assignee_membership_id" uuid,
	"to_assignee_membership_id" uuid,
	"from_status" text,
	"to_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_events_kind_check" CHECK ("conversation_events"."kind" IN ('ASSIGNMENT', 'STATUS')),
	CONSTRAINT "conversation_events_status_values_check" CHECK (("conversation_events"."from_status" IS NULL OR "conversation_events"."from_status" IN ('OPEN', 'PENDING', 'RESOLVED'))
        AND ("conversation_events"."to_status" IS NULL OR "conversation_events"."to_status" IN ('OPEN', 'PENDING', 'RESOLVED'))),
	CONSTRAINT "conversation_events_shape_check" CHECK (("conversation_events"."kind" = 'ASSIGNMENT'
            AND "conversation_events"."from_status" IS NULL AND "conversation_events"."to_status" IS NULL
            AND "conversation_events"."from_assignee_membership_id" IS DISTINCT FROM "conversation_events"."to_assignee_membership_id")
          OR ("conversation_events"."kind" = 'STATUS'
            AND "conversation_events"."from_assignee_membership_id" IS NULL AND "conversation_events"."to_assignee_membership_id" IS NULL
            AND "conversation_events"."from_status" IS NOT NULL AND "conversation_events"."to_status" IS NOT NULL
            AND "conversation_events"."from_status" <> "conversation_events"."to_status"))
);
--> statement-breakpoint
CREATE TABLE "conversation_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_membership_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_notes_body_check" CHECK (char_length("conversation_notes"."body") BETWEEN 1 AND 4000 AND btrim("conversation_notes"."body") <> '')
);
--> statement-breakpoint
CREATE TABLE "message_reads" (
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reads_pk" PRIMARY KEY("organization_id","membership_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "quick_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"title_key" text GENERATED ALWAYS AS (lower(btrim(title))) STORED NOT NULL,
	"body" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_replies_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "quick_replies_title_check" CHECK (char_length("quick_replies"."title") BETWEEN 1 AND 60 AND btrim("quick_replies"."title") <> ''),
	CONSTRAINT "quick_replies_body_check" CHECK (char_length("quick_replies"."body") BETWEEN 1 AND 1000 AND btrim("quick_replies"."body") <> '')
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "assigned_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_org_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_org_actor_fk" FOREIGN KEY ("organization_id","actor_membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_org_from_assignee_fk" FOREIGN KEY ("organization_id","from_assignee_membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_org_to_assignee_fk" FOREIGN KEY ("organization_id","to_assignee_membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_org_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_org_author_fk" FOREIGN KEY ("organization_id","author_membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_org_membership_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_org_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."messages"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_org_creator_fk" FOREIGN KEY ("organization_id","created_by_membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_events_conversation_idx" ON "conversation_events" USING btree ("organization_id","conversation_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "conversation_notes_conversation_idx" ON "conversation_notes" USING btree ("organization_id","conversation_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "message_reads_message_idx" ON "message_reads" USING btree ("organization_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quick_replies_org_active_title_uidx" ON "quick_replies" USING btree ("organization_id","title_key") WHERE "quick_replies"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_assignee_fk" FOREIGN KEY ("organization_id","assigned_membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_org_activity_idx" ON "conversations" USING btree ("organization_id","last_message_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "conversations_assignee_idx" ON "conversations" USING btree ("organization_id","assigned_membership_id","last_message_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "conversations"."assigned_membership_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_inbound_conversation_idx" ON "messages" USING btree ("organization_id","conversation_id","id") WHERE "messages"."direction" = 'INBOUND';--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignment_check" CHECK (("conversations"."assigned_membership_id" IS NULL) = ("conversations"."assigned_at" IS NULL));
--> statement-breakpoint
-- Hand-written (Drizzle cannot generate triggers). Workflow history and internal notes are append-only: accountability
-- is only worth anything if a row can never be edited or removed afterwards. (A future retention job must be an explicit,
-- reviewed migration that disables this deliberately.)
CREATE FUNCTION staff_inbox_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_events_append_only_trg BEFORE UPDATE OR DELETE ON "conversation_events" FOR EACH ROW EXECUTE FUNCTION staff_inbox_append_only();
--> statement-breakpoint
CREATE TRIGGER conversation_notes_append_only_trg BEFORE UPDATE OR DELETE ON "conversation_notes" FOR EACH ROW EXECUTE FUNCTION staff_inbox_append_only();
