-- Migration 0006: leads lifecycle, lead history, reconcile decisions and protection of attribution evidence (ADR 0016).
-- Additive: four columns and one foreign key on leads, one unique constraint and one index on lead_attributions, two new
-- tables, indexes, CHECK constraints and triggers. No existing row is deleted, no existing touch is linked, unlinked or rewritten, and no history
-- is invented for leads or links that already exist.
--
-- PREFLIGHT (read-only; run it against the target database BEFORE deploying this migration):
--   SELECT organization_id, contact_id, count(*) AS open_leads, array_agg(id ORDER BY created_at) AS lead_ids
--   FROM leads
--   WHERE status IN ('NEW', 'QUALIFIED', 'INTERESTED', 'REGISTRATION_STARTED', 'REGISTERED', 'PAID')
--   GROUP BY organization_id, contact_id
--   HAVING count(*) > 1;
-- Any row returned is a contact with more than one OPEN lead, which the new rule "one open lead per contact" forbids. This
-- migration refuses to proceed past it and changes NOTHING (the migrator runs it in one transaction): leads are never closed,
-- merged or deleted automatically. Decide by hand which lead stays open, close the others, and retry.
--
-- OPERATIONAL NOTE: the statements below take short ACCESS EXCLUSIVE locks on leads and lead_attributions (new columns,
-- constraints, triggers) and build indexes inside the migration transaction. Both tables are small (nothing creates leads
-- before this phase; touches come only from Click-to-WhatsApp referrals), but apply it during a quiet period with the webhook
-- worker stopped: events simply wait in the queue.
DO $$
DECLARE
	contacts_with_several_open integer;
BEGIN
	SELECT count(*) INTO contacts_with_several_open FROM (
		SELECT 1 FROM "leads"
		WHERE "status" IN ('NEW', 'QUALIFIED', 'INTERESTED', 'REGISTRATION_STARTED', 'REGISTERED', 'PAID')
		GROUP BY "organization_id", "contact_id"
		HAVING count(*) > 1
	) AS d;
	IF contacts_with_several_open > 0 THEN
		RAISE EXCEPTION 'migration 0006 refused: % contact(s) have more than one open lead; no rows were changed. Resolve them manually (see the preflight query in this file) and retry.', contacts_with_several_open
			USING ERRCODE = 'unique_violation';
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_membership_id" uuid,
	"origin" text,
	"from_status" text,
	"to_status" text,
	"attribution_id" uuid,
	"revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_events_kind_check" CHECK ("lead_events"."kind" IN ('CREATED', 'STATUS', 'TOUCH_LINKED')),
	CONSTRAINT "lead_events_origin_check" CHECK ("lead_events"."origin" IS NULL OR "lead_events"."origin" IN ('MANUAL', 'AD_REFERRAL')),
	CONSTRAINT "lead_events_status_values_check" CHECK (("lead_events"."from_status" IS NULL OR "lead_events"."from_status" IN ('NEW', 'QUALIFIED', 'INTERESTED', 'NOT_INTERESTED', 'NO_RESPONSE', 'INVALID'))
        AND ("lead_events"."to_status" IS NULL OR "lead_events"."to_status" IN ('NEW', 'QUALIFIED', 'INTERESTED', 'NOT_INTERESTED', 'NO_RESPONSE', 'INVALID'))),
	CONSTRAINT "lead_events_shape_check" CHECK ((("lead_events"."kind" = 'CREATED'
            AND "lead_events"."from_status" IS NULL AND "lead_events"."to_status" IS NULL
            AND "lead_events"."revision" IS NOT NULL AND "lead_events"."revision" = 0
            AND "lead_events"."origin" IS NOT NULL
            AND (("lead_events"."origin" = 'MANUAL' AND "lead_events"."actor_membership_id" IS NOT NULL AND "lead_events"."attribution_id" IS NULL)
              OR ("lead_events"."origin" = 'AD_REFERRAL' AND "lead_events"."actor_membership_id" IS NULL AND "lead_events"."attribution_id" IS NOT NULL)))
          OR ("lead_events"."kind" = 'STATUS'
            AND "lead_events"."origin" IS NULL AND "lead_events"."attribution_id" IS NULL AND "lead_events"."actor_membership_id" IS NOT NULL
            AND "lead_events"."from_status" IS NOT NULL AND "lead_events"."to_status" IS NOT NULL
            AND "lead_events"."from_status" <> "lead_events"."to_status"
            AND "lead_events"."revision" IS NOT NULL AND "lead_events"."revision" >= 1)
          OR ("lead_events"."kind" = 'TOUCH_LINKED'
            AND "lead_events"."origin" IS NULL AND "lead_events"."attribution_id" IS NOT NULL
            AND "lead_events"."from_status" IS NULL AND "lead_events"."to_status" IS NULL AND "lead_events"."revision" IS NULL)) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "lead_reconcile_decisions" (
	"organization_id" uuid NOT NULL,
	"attribution_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_reconcile_decisions_pk" PRIMARY KEY("organization_id","attribution_id"),
	CONSTRAINT "lead_reconcile_decisions_decision_check" CHECK ("lead_reconcile_decisions"."decision" IN ('SKIPPED_STALE', 'SKIPPED_BEFORE_CYCLE', 'SKIPPED_CONVERTED', 'SKIPPED_ARCHIVED', 'RETRY', 'PARKED')),
	CONSTRAINT "lead_reconcile_decisions_shape_check" CHECK ((("lead_reconcile_decisions"."decision" = 'RETRY'
            AND "lead_reconcile_decisions"."attempts" BETWEEN 1 AND 4
            AND "lead_reconcile_decisions"."next_attempt_at" IS NOT NULL)
          OR ("lead_reconcile_decisions"."decision" = 'PARKED'
            AND "lead_reconcile_decisions"."attempts" = 5
            AND "lead_reconcile_decisions"."next_attempt_at" IS NULL)
          OR ("lead_reconcile_decisions"."decision" IN ('SKIPPED_STALE', 'SKIPPED_BEFORE_CYCLE', 'SKIPPED_CONVERTED', 'SKIPPED_ARCHIVED')
            AND "lead_reconcile_decisions"."attempts" BETWEEN 0 AND 4
            AND "lead_reconcile_decisions"."next_attempt_at" IS NULL)) IS TRUE),
	CONSTRAINT "lead_reconcile_decisions_error_code_check" CHECK ("lead_reconcile_decisions"."last_error_code" IS NULL OR "lead_reconcile_decisions"."last_error_code" ~ '^[a-z0-9_.:-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "closed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "cycle_started_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- Hand-written backfill for leads that already exist (revision, closed_at and cycle_started_at only; nothing else is touched
-- and no history is invented). initiating_attribution_id stays NULL for every existing lead: no provenance is invented either.
-- cycle_started_at: nothing earlier than the row's own creation is known, so the cycle is taken to have started then (LEAST
-- with status_changed_at only keeps closed_at >= cycle_started_at true for rows with unusual timestamps).
-- closed_at: a lead that is already in a closed status is taken to have closed when its status last changed.
UPDATE "leads" SET
	"cycle_started_at" = LEAST("created_at", "status_changed_at"),
	"closed_at" = CASE WHEN "status" IN ('CONVERTED', 'NOT_INTERESTED', 'NO_RESPONSE', 'INVALID') THEN "status_changed_at" END;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "initiating_attribution_id" uuid;
--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_org_lead_contact_fk" FOREIGN KEY ("organization_id","lead_id","contact_id") REFERENCES "public"."leads"("organization_id","id","contact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_org_actor_fk" FOREIGN KEY ("organization_id","actor_membership_id") REFERENCES "public"."organization_memberships"("organization_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Moved up by hand: the foreign keys below reference this constraint, so it has to exist first.
ALTER TABLE "lead_attributions" ADD CONSTRAINT "lead_attributions_org_id_contact_unique" UNIQUE("organization_id","id","contact_id");
--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_org_attribution_contact_fk" FOREIGN KEY ("organization_id","attribution_id","contact_id") REFERENCES "public"."lead_attributions"("organization_id","id","contact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_reconcile_decisions" ADD CONSTRAINT "lead_reconcile_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_reconcile_decisions" ADD CONSTRAINT "lead_reconcile_decisions_org_attribution_contact_fk" FOREIGN KEY ("organization_id","attribution_id","contact_id") REFERENCES "public"."lead_attributions"("organization_id","id","contact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "lead_events_lead_idx" ON "lead_events" USING btree ("organization_id","lead_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
--> statement-breakpoint
CREATE UNIQUE INDEX "lead_events_created_uidx" ON "lead_events" USING btree ("organization_id","lead_id") WHERE "lead_events"."kind" = 'CREATED';
--> statement-breakpoint
CREATE UNIQUE INDEX "lead_events_created_attribution_uidx" ON "lead_events" USING btree ("organization_id","attribution_id") WHERE "lead_events"."kind" = 'CREATED' AND "lead_events"."attribution_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "lead_events_touch_linked_uidx" ON "lead_events" USING btree ("organization_id","attribution_id") WHERE "lead_events"."kind" = 'TOUCH_LINKED';
--> statement-breakpoint
CREATE UNIQUE INDEX "lead_events_status_revision_uidx" ON "lead_events" USING btree ("organization_id","lead_id","revision") WHERE "lead_events"."kind" = 'STATUS';
--> statement-breakpoint
CREATE INDEX "lead_reconcile_decisions_due_idx" ON "lead_reconcile_decisions" USING btree ("next_attempt_at","attribution_id") WHERE "lead_reconcile_decisions"."decision" = 'RETRY';
--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_initiating_attribution_contact_fk" FOREIGN KEY ("organization_id","initiating_attribution_id","contact_id") REFERENCES "public"."lead_attributions"("organization_id","id","contact_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "lead_attributions_unlinked_ad_idx" ON "lead_attributions" USING btree ("received_at","id") WHERE "lead_attributions"."lead_id" IS NULL AND "lead_attributions"."source_type" = 'META_AD' AND "lead_attributions"."message_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "leads_org_created_idx" ON "leads" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
--> statement-breakpoint
CREATE UNIQUE INDEX "leads_org_contact_open_uidx" ON "leads" USING btree ("organization_id","contact_id") WHERE "leads"."status" IN ('NEW', 'QUALIFIED', 'INTERESTED', 'REGISTRATION_STARTED', 'REGISTERED', 'PAID');
--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_revision_check" CHECK ("leads"."revision" >= 0);
--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_status_closed_at_check" CHECK (("leads"."closed_at" IS NULL) = ("leads"."status" IN ('NEW', 'QUALIFIED', 'INTERESTED', 'REGISTRATION_STARTED', 'REGISTERED', 'PAID')));
--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_cycle_order_check" CHECK ("leads"."closed_at" IS NULL OR "leads"."closed_at" >= "leads"."cycle_started_at");
--> statement-breakpoint
-- Everything below is hand-written (Drizzle cannot generate functions or triggers). Messages are fixed text: they never
-- contain row content. All functions rely on READ COMMITTED (the application's isolation level), where each query inside a
-- trigger function sees what other transactions have committed by then.
--
-- LOCK ORDER (design contract for every writer; ADR 0016): 1. the contact-scoped advisory lock, 2. the lead row,
-- 3. the attribution row, 4. the reconcile decision row, 5. history insertion. The triggers below read the lead FOR SHARE and
-- the attribution FOR SHARE so that the rules hold even for a writer that ignores the contract; a writer that follows it
-- already holds those locks. One trigger cannot follow the order by itself: the guard on lead_reconcile_decisions runs when
-- the decision row is already locked and only then locks the attribution row (4 before 3). A writer that holds the contact
-- lock is not affected; one that does not may deadlock against a concurrent link, which PostgreSQL detects and aborts.

-- 1. Lead history is append-only.
CREATE FUNCTION lead_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'lead_events is append-only: % is not allowed', TG_OP USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lead_events_append_only_trg BEFORE UPDATE OR DELETE ON "lead_events" FOR EACH ROW EXECUTE FUNCTION lead_events_append_only();
--> statement-breakpoint
-- 2. A new lead. It starts at revision 0, so that a revision can only ever be reached by that many recorded status changes.
--    A lead that a Meta ad referral creates names that touch in its own INSERT (initiating_attribution_id): the INSERT is the
--    creation, and the column never changes afterwards, so no later statement can claim a touch as the origin of a lead that
--    already exists. For such a lead the DATABASE sets cycle_started_at to the touch's receipt time (a supplied value is
--    ignored): the cycle of an automatic lead is derived from the evidence, never from a timestamp the writer chose.
--    The touch is read without a lock: source_type, message_id and received_at never change, and "not linked yet" is only an
--    early refusal here. What decides is checked at COMMIT (triggers 3 and 8): the lead must have its CREATED event naming
--    this touch, and the touch must be linked to this lead.
CREATE FUNCTION leads_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	touch record;
BEGIN
	IF NEW."revision" <> 0 THEN
		RAISE EXCEPTION 'leads: a new lead starts at revision 0' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW."initiating_attribution_id" IS NULL THEN
		RETURN NEW;
	END IF;
	SELECT a."source_type", a."message_id", a."lead_id", a."received_at" INTO touch FROM "lead_attributions" a
	WHERE a."organization_id" = NEW."organization_id" AND a."id" = NEW."initiating_attribution_id"
		AND a."contact_id" = NEW."contact_id";
	IF NOT FOUND THEN
		RETURN NEW; -- no such touch for this contact: the foreign key reports it
	END IF;
	IF touch."source_type" <> 'META_AD' OR touch."message_id" IS NULL THEN
		RAISE EXCEPTION 'leads: only a confirmed Meta ad referral that arrived with a message can create a lead' USING ERRCODE = 'check_violation';
	END IF;
	IF touch."lead_id" IS NOT NULL THEN
		RAISE EXCEPTION 'leads: a touch that is already linked cannot create a lead' USING ERRCODE = 'check_violation';
	END IF;
	NEW."cycle_started_at" := touch."received_at";
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER leads_insert_guard_trg BEFORE INSERT ON "leads" FOR EACH ROW EXECUTE FUNCTION leads_insert_guard();
--> statement-breakpoint
-- 3. A lead created by an ad referral commits together with its CREATED history event naming the same touch (trigger 8 then
--    requires that touch to be linked to the lead). So lead, creation record, link and link history are one transaction.
CREATE FUNCTION leads_ad_creation_needs_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "lead_events" e
		WHERE e."organization_id" = NEW."organization_id" AND e."lead_id" = NEW."id"
			AND e."kind" = 'CREATED' AND e."attribution_id" = NEW."initiating_attribution_id"
	) THEN
		RAISE EXCEPTION 'leads: a lead created by an ad referral was inserted without its CREATED history event' USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER leads_ad_creation_history_trg AFTER INSERT ON "leads"
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	WHEN (NEW."initiating_attribution_id" IS NOT NULL)
	EXECUTE FUNCTION leads_ad_creation_needs_history();
--> statement-breakpoint
-- 4. Lead transitions. revision is the optimistic-concurrency token: +1 with every status change, never otherwise.
--    closed_at is the start of the CURRENT closed period: it does not move while the lead stays closed. cycle_started_at moves
--    only when a closed lead is reopened, to the reopening time. (Which closed_at/status pairs are legal is a CHECK.)
--    The initiating touch is a fact of the lead's creation and never changes.
CREATE FUNCTION leads_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	was_open boolean := OLD."closed_at" IS NULL;
	is_open boolean := NEW."closed_at" IS NULL;
BEGIN
	IF NEW."organization_id" <> OLD."organization_id" OR NEW."contact_id" <> OLD."contact_id" THEN
		RAISE EXCEPTION 'leads: a lead never moves to another contact or organization' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW."initiating_attribution_id" IS DISTINCT FROM OLD."initiating_attribution_id" THEN
		RAISE EXCEPTION 'leads: the touch a lead was created from is recorded by its INSERT and never changes' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW."status" <> OLD."status" THEN
		IF NEW."revision" <> OLD."revision" + 1 THEN
			RAISE EXCEPTION 'leads: a status change must increase revision by exactly 1' USING ERRCODE = 'check_violation';
		END IF;
	ELSIF NEW."revision" <> OLD."revision" THEN
		RAISE EXCEPTION 'leads: revision changes only together with the status' USING ERRCODE = 'check_violation';
	END IF;
	IF was_open THEN
		IF NEW."cycle_started_at" <> OLD."cycle_started_at" THEN
			RAISE EXCEPTION 'leads: cycle_started_at changes only when a closed lead is reopened' USING ERRCODE = 'check_violation';
		END IF;
	ELSIF is_open THEN
		IF NEW."cycle_started_at" < OLD."closed_at" THEN
			RAISE EXCEPTION 'leads: a reopened lead starts a new cycle at the reopening time, not before it was closed' USING ERRCODE = 'check_violation';
		END IF;
	ELSIF NEW."closed_at" <> OLD."closed_at" OR NEW."cycle_started_at" <> OLD."cycle_started_at" THEN
		RAISE EXCEPTION 'leads: closed_at and cycle_started_at do not move while the lead stays closed' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER leads_transition_guard_trg BEFORE UPDATE ON "leads" FOR EACH ROW EXECUTE FUNCTION leads_transition_guard();
--> statement-breakpoint
-- 5. Attribution evidence. A touch is inserted unlinked, is never deleted, and nothing in it ever changes except lead_id, once,
--    from NULL to a lead. A link is accepted only when ALL of these hold:
--      - the touch is a confirmed Meta ad referral (source_type META_AD) that arrived with a message;
--      - it has no terminal reconcile decision (a skipped or parked touch is never attached);
--      - the lead is open (and belongs to the same contact: the foreign key);
--      - the touch does not predate the lead's cycle. Two timestamps describe a touch and neither is the time of the ad
--        click: received_at (when this platform received the delivery) and the message's occurred_at (the provider's
--        timestamp). When they disagree the EARLIER one is used, so evidence that may be old is left at contact level instead
--        of being attached to a newer cycle.
--        The one exception is the lead's initiating touch (leads.initiating_attribution_id, written by the lead's INSERT and
--        immutable): its provider time is normally a little earlier than its receipt time, which IS the cycle start, so only
--        its receipt time is compared. Nothing else is waived, and no history event can grant this exception.
CREATE FUNCTION lead_attributions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	target record;
	evidence_at timestamptz;
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'lead_attributions: attribution evidence cannot be deleted' USING ERRCODE = 'check_violation';
	END IF;
	IF TG_OP = 'INSERT' THEN
		IF NEW."lead_id" IS NOT NULL THEN
			RAISE EXCEPTION 'lead_attributions: a touch is inserted unlinked and linked to a lead afterwards' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF (to_jsonb(NEW) - 'lead_id') IS DISTINCT FROM (to_jsonb(OLD) - 'lead_id') THEN
		RAISE EXCEPTION 'lead_attributions: attribution evidence is immutable' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW."lead_id" IS NOT DISTINCT FROM OLD."lead_id" THEN
		RETURN NEW; -- nothing changes
	END IF;
	IF OLD."lead_id" IS NOT NULL THEN
		RAISE EXCEPTION 'lead_attributions: a touch is linked once and the link never changes' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW."source_type" <> 'META_AD' OR NEW."message_id" IS NULL THEN
		RAISE EXCEPTION 'lead_attributions: only a confirmed Meta ad referral that arrived with a message can be linked to a lead' USING ERRCODE = 'check_violation';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "lead_reconcile_decisions" d
		WHERE d."organization_id" = NEW."organization_id" AND d."attribution_id" = NEW."id" AND d."decision" <> 'RETRY'
	) THEN
		RAISE EXCEPTION 'lead_attributions: a touch with a terminal reconcile decision cannot be linked' USING ERRCODE = 'check_violation';
	END IF;
	SELECT l."closed_at", l."cycle_started_at", l."initiating_attribution_id" INTO target FROM "leads" l
	WHERE l."organization_id" = NEW."organization_id" AND l."id" = NEW."lead_id" AND l."contact_id" = NEW."contact_id"
	FOR SHARE;
	IF NOT FOUND THEN
		RETURN NEW; -- no such lead for this contact: the foreign key reports it
	END IF;
	IF target."closed_at" IS NOT NULL THEN
		RAISE EXCEPTION 'lead_attributions: a touch can only be linked to an open lead' USING ERRCODE = 'check_violation';
	END IF;
	IF target."initiating_attribution_id" = NEW."id" THEN
		evidence_at := NEW."received_at";
	ELSE
		SELECT LEAST(NEW."received_at", m."occurred_at") INTO evidence_at FROM "messages" m
		WHERE m."organization_id" = NEW."organization_id" AND m."id" = NEW."message_id";
	END IF;
	-- (evidence_at cannot be NULL: the message exists by foreign key. If it ever were, the link is refused, not waved through.)
	IF evidence_at IS NULL OR evidence_at < target."cycle_started_at" THEN
		RAISE EXCEPTION 'lead_attributions: a touch cannot be linked to a lead cycle it predates' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lead_attributions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "lead_attributions" FOR EACH ROW EXECUTE FUNCTION lead_attributions_guard();
--> statement-breakpoint
-- 6. A link and its history commit together: at COMMIT a newly linked touch must have its TOUCH_LINKED event for that lead.
--    And a linked touch keeps no reconcile decision: a RETRY row that was waiting for this touch must have been deleted by the
--    linking transaction (after the link; trigger 10 refuses the DELETE before it). A decision cannot appear later either
--    (trigger 10 refuses one for a linked touch), so "linked" and "has a decision row" never hold together.
CREATE FUNCTION lead_attributions_link_needs_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "lead_events" e
		WHERE e."organization_id" = NEW."organization_id" AND e."kind" = 'TOUCH_LINKED'
			AND e."attribution_id" = NEW."id" AND e."lead_id" = NEW."lead_id"
	) THEN
		RAISE EXCEPTION 'lead_attributions: a touch was linked to a lead without its TOUCH_LINKED history event' USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	IF EXISTS (
		SELECT 1 FROM "lead_reconcile_decisions" d
		WHERE d."organization_id" = NEW."organization_id" AND d."attribution_id" = NEW."id"
	) THEN
		RAISE EXCEPTION 'lead_attributions: a touch was linked to a lead while it still has a reconcile decision' USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lead_attributions_link_history_trg AFTER UPDATE OF "lead_id" ON "lead_attributions"
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	WHEN (OLD."lead_id" IS DISTINCT FROM NEW."lead_id")
	EXECUTE FUNCTION lead_attributions_link_needs_history();
--> statement-breakpoint
-- 7. History must match reality. A TOUCH_LINKED event is accepted only for a touch that IS linked to that lead (link first,
--    then the event). A STATUS event is accepted only when the lead IS in that status at that revision (change first, then the
--    event). A CREATED event must name exactly the touch the lead's own INSERT recorded, and none for a lead that was not
--    created from a touch: history cannot give a lead an origin it did not have. (The column is immutable, so no lock.)
CREATE FUNCTION lead_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	initiating uuid;
BEGIN
	IF NEW."kind" = 'TOUCH_LINKED' THEN
		IF NOT EXISTS (
			SELECT 1 FROM "lead_attributions" a
			WHERE a."organization_id" = NEW."organization_id" AND a."id" = NEW."attribution_id" AND a."lead_id" = NEW."lead_id"
		) THEN
			RAISE EXCEPTION 'lead_events: a TOUCH_LINKED event needs the touch to be linked to that lead' USING ERRCODE = 'integrity_constraint_violation';
		END IF;
	ELSIF NEW."kind" = 'STATUS' THEN
		IF NOT EXISTS (
			SELECT 1 FROM "leads" l
			WHERE l."organization_id" = NEW."organization_id" AND l."id" = NEW."lead_id"
				AND l."status" = NEW."to_status" AND l."revision" = NEW."revision"
		) THEN
			RAISE EXCEPTION 'lead_events: a STATUS event needs the lead to be in that status at that revision' USING ERRCODE = 'integrity_constraint_violation';
		END IF;
	ELSIF NEW."kind" = 'CREATED' THEN
		SELECT l."initiating_attribution_id" INTO initiating FROM "leads" l
		WHERE l."organization_id" = NEW."organization_id" AND l."id" = NEW."lead_id";
		IF NOT FOUND THEN
			RETURN NEW; -- the foreign key reports it
		END IF;
		IF NEW."attribution_id" IS DISTINCT FROM initiating THEN
			RAISE EXCEPTION 'lead_events: a CREATED event names the touch recorded by the INSERT of the lead, and no other' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lead_events_guard_trg BEFORE INSERT ON "lead_events" FOR EACH ROW EXECUTE FUNCTION lead_events_guard();
--> statement-breakpoint
-- 8. The touch that created a lead is linked to it in the same transaction: checked at COMMIT.
CREATE FUNCTION lead_events_creating_touch_linked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "lead_attributions" a
		WHERE a."organization_id" = NEW."organization_id" AND a."id" = NEW."attribution_id" AND a."lead_id" = NEW."lead_id"
	) THEN
		RAISE EXCEPTION 'lead_events: the touch that created a lead must be linked to it in the same transaction' USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lead_events_creating_touch_trg AFTER INSERT ON "lead_events"
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	WHEN (NEW."kind" = 'CREATED' AND NEW."attribution_id" IS NOT NULL)
	EXECUTE FUNCTION lead_events_creating_touch_linked();
--> statement-breakpoint
-- 9. A status change and its history commit together: at COMMIT every status change must have its STATUS event, with the
--    revision it produced and the exact from/to statuses. So every closure and reopening stays recoverable from lead_events,
--    and (because history can only record the staff-settable statuses) no update can put a lead into a reserved status.
CREATE FUNCTION leads_status_change_needs_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "lead_events" e
		WHERE e."organization_id" = NEW."organization_id" AND e."lead_id" = NEW."id" AND e."kind" = 'STATUS'
			AND e."revision" = NEW."revision" AND e."from_status" = OLD."status" AND e."to_status" = NEW."status"
	) THEN
		RAISE EXCEPTION 'leads: a status change was made without its STATUS history event' USING ERRCODE = 'integrity_constraint_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER leads_status_history_trg AFTER UPDATE OF "status" ON "leads"
	DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
	WHEN (OLD."status" IS DISTINCT FROM NEW."status")
	EXECUTE FUNCTION leads_status_change_needs_history();
--> statement-breakpoint
-- 10. Reconcile decisions. Every INSERT, UPDATE and DELETE first locks the touch (FOR SHARE) and looks at its link, so a
--     decision and a link for the same touch are always decided one after the other, whichever starts first:
--      - a decision is recorded or changed only for a touch that is NOT linked;
--      - SKIPPED_* and PARKED are terminal: never changed, never deleted, so skipped evidence cannot be silently reactivated;
--      - a RETRY row is deleted only when its touch IS linked, which before COMMIT only the linking transaction can see: the
--        order is link first, then DELETE. Deleting it earlier is refused, so the attempt count cannot be reset by deleting
--        the row and inserting a fresh one (a decision cannot be inserted for a linked touch either);
--      - attempts never decrease;
--      - a retry is scheduled in the future, by the DATABASE clock, whenever a schedule is assigned: on INSERT, and on an
--        UPDATE that changes attempts or next_attempt_at. A row that is merely waiting, or already due, stays valid: nothing
--        is re-checked when time passes, and an UPDATE that touches neither column does not look at the clock.
CREATE FUNCTION lead_reconcile_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	subject record;
	linked_to uuid;
	rescheduled boolean := TG_OP = 'INSERT';
BEGIN
	IF TG_OP = 'INSERT' THEN
		subject := NEW;
	ELSE
		subject := OLD;
		IF OLD."decision" <> 'RETRY' THEN
			RAISE EXCEPTION 'lead_reconcile_decisions: a terminal decision is final (% is not allowed)', TG_OP USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	IF TG_OP = 'UPDATE' THEN
		IF NEW."organization_id" <> OLD."organization_id" OR NEW."attribution_id" <> OLD."attribution_id"
			OR NEW."contact_id" <> OLD."contact_id" THEN
			RAISE EXCEPTION 'lead_reconcile_decisions: a decision stays with its touch' USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	SELECT a."lead_id" INTO linked_to FROM "lead_attributions" a
	WHERE a."organization_id" = subject."organization_id" AND a."id" = subject."attribution_id"
	FOR SHARE;
	IF TG_OP = 'DELETE' THEN
		IF linked_to IS NULL THEN
			RAISE EXCEPTION 'lead_reconcile_decisions: a RETRY decision is deleted only after its touch has been linked, by the linking transaction' USING ERRCODE = 'check_violation';
		END IF;
		RETURN OLD;
	END IF;
	IF linked_to IS NOT NULL THEN
		RAISE EXCEPTION 'lead_reconcile_decisions: a linked touch has no reconcile decision' USING ERRCODE = 'check_violation';
	END IF;
	IF TG_OP = 'UPDATE' THEN
		IF NEW."attempts" < OLD."attempts" THEN
			RAISE EXCEPTION 'lead_reconcile_decisions: attempts never decrease' USING ERRCODE = 'check_violation';
		END IF;
		rescheduled := NEW."attempts" <> OLD."attempts" OR NEW."next_attempt_at" IS DISTINCT FROM OLD."next_attempt_at";
	END IF;
	-- (a RETRY without a due time is reported by the shape CHECK)
	IF NEW."decision" = 'RETRY' AND rescheduled AND NEW."next_attempt_at" <= clock_timestamp() THEN
		RAISE EXCEPTION 'lead_reconcile_decisions: a retry is scheduled in the future, by the database clock' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lead_reconcile_decisions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "lead_reconcile_decisions" FOR EACH ROW EXECUTE FUNCTION lead_reconcile_decisions_guard();
