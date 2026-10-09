-- Migration 0003: one attribution per referring inbound message.
--
-- Adds a database guarantee for the rule "a message has at most one lead_attributions row": a partial unique index on
-- (organization_id, message_id) for rows that have a message. Rows with message_id NULL are not constrained by it.
--
-- PREFLIGHT (read-only; run it against the target database BEFORE deploying this migration):
--   SELECT organization_id, message_id, count(*) AS rows, array_agg(id ORDER BY created_at) AS attribution_ids
--   FROM lead_attributions
--   WHERE message_id IS NOT NULL
--   GROUP BY organization_id, message_id
--   HAVING count(*) > 1;
-- Any row returned is a duplicate that this migration will refuse to proceed past. Rows are NEVER deleted or merged by this
-- migration: review the duplicates by hand (the earliest touch is the first-touch attribution), decide which to keep, and
-- resolve them yourself before retrying.
--
-- OPERATIONAL NOTE: CREATE UNIQUE INDEX (not CONCURRENTLY, because the migrator runs inside a transaction) takes a SHARE
-- lock on lead_attributions while it builds, blocking inserts, updates and deletes on that table (reads continue) for the
-- time it takes to scan it. The table only receives rows from Click-to-WhatsApp referrals, so it is normally small, but do
-- not assume it is instant on a populated database: check the row count first and apply during a quiet period, with the
-- webhook worker stopped (events simply wait in the queue). A CONCURRENTLY build would have to be applied by hand outside
-- the migrator and is not part of this migration.
DO $$
DECLARE
	duplicate_pairs integer;
BEGIN
	SELECT count(*) INTO duplicate_pairs FROM (
		SELECT 1 FROM "lead_attributions"
		WHERE "message_id" IS NOT NULL
		GROUP BY "organization_id", "message_id"
		HAVING count(*) > 1
	) AS d;
	IF duplicate_pairs > 0 THEN
		RAISE EXCEPTION 'migration 0003 refused: % (organization_id, message_id) pair(s) in lead_attributions have more than one row; no rows were changed. Resolve them manually (see the preflight query in this file) and retry.', duplicate_pairs
			USING ERRCODE = 'unique_violation';
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_attributions_org_message_uidx" ON "lead_attributions" USING btree ("organization_id","message_id") WHERE "lead_attributions"."message_id" IS NOT NULL;
