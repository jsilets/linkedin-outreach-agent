-- Canonical-URN backfill + dedup, then the new targets indexes.
--
-- Identity used to be keyed on the volatile people-search wrapper
--   urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:<id>,SEARCH_SRP,DEFAULT)
-- instead of the stable bare urn:li:fsd_profile:<id>. This re-keys existing rows
-- to the bare form (the same regex the app's canonicalProfileKey uses) BEFORE the
-- unique index is built, so live data survives.
--
-- Ordering matters and is why the data steps sit ABOVE the drizzle-generated DDL:
-- the (campaign_id, linkedin_urn) unique index would reject the pre-backfill rows
-- otherwise. Every statement is idempotent (guarded UPDATEs, keep-one DELETEs),
-- so a re-run is a no-op. Deletes only ever remove SURPLUS rows: for lead-list
-- members there are no dependents; for targets we delete only duplicates that
-- carry NO target_progress / actions / messages, so no enrollment is orphaned.

-- 1. Collapse lead-list members that resolve to the same person within a list,
--    keeping the earliest. Must precede the rekey, which would otherwise violate
--    the existing (list_id, linkedin_urn) unique index mid-UPDATE.
DELETE FROM "lead_list_members" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
      row_number() OVER (
        PARTITION BY "list_id", substring("linkedin_urn" from 'urn:li:fsd_profile:[A-Za-z0-9_-]+')
        ORDER BY "added_at" ASC, "id" ASC
      ) AS rn
    FROM "lead_list_members"
    WHERE "linkedin_urn" ~ 'urn:li:fsd_profile:'
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint

-- 2. Re-key lead-list members to the bare person urn. Rows with no fsd_profile
--    token (dev refs, urls) and already-bare rows are left untouched.
UPDATE "lead_list_members"
SET "linkedin_urn" = substring("linkedin_urn" from 'urn:li:fsd_profile:[A-Za-z0-9_-]+')
WHERE "linkedin_urn" ~ 'urn:li:fsd_profile:'
  AND "linkedin_urn" <> substring("linkedin_urn" from 'urn:li:fsd_profile:[A-Za-z0-9_-]+');--> statement-breakpoint

-- 3. Re-key campaign targets to the bare person urn (no unique index yet, so an
--    UPDATE that collapses two rows to the same value cannot fault here).
UPDATE "targets"
SET "linkedin_urn" = substring("linkedin_urn" from 'urn:li:fsd_profile:[A-Za-z0-9_-]+')
WHERE "linkedin_urn" ~ 'urn:li:fsd_profile:'
  AND "linkedin_urn" <> substring("linkedin_urn" from 'urn:li:fsd_profile:[A-Za-z0-9_-]+');--> statement-breakpoint

-- 4. Collapse duplicate targets per (campaign_id, bare urn) WITHOUT orphaning
--    anything, so the unique index below can never fail on a 2-dependent
--    collision. Pick one survivor per group (prefers the row holding the
--    enrollment cursor, then any dependent, then the oldest), re-point the
--    losers' history onto it, drop the losers' cursors, then delete the losers.
--    The survivor/loser map is materialized once into a temp table so the
--    ordered statements below all use the SAME split even as the re-points
--    change has_deps. Idempotent: after the first run there are no duplicates,
--    so the map is empty and every statement is a no-op.
DROP TABLE IF EXISTS "_dup_targets";--> statement-breakpoint

CREATE TEMP TABLE "_dup_targets" AS
  SELECT "id" AS loser_id, survivor_id
  FROM (
    SELECT t."id",
      first_value(t."id") OVER w AS survivor_id,
      row_number() OVER w AS rn
    FROM (
      SELECT "id", "campaign_id", "linkedin_urn", "created_at",
        EXISTS (SELECT 1 FROM "target_progress" tp WHERE tp."target_id" = "targets"."id") AS has_progress,
        (EXISTS (SELECT 1 FROM "target_progress" tp WHERE tp."target_id" = "targets"."id")
          OR EXISTS (SELECT 1 FROM "actions" a WHERE a."target_id" = "targets"."id")
          OR EXISTS (SELECT 1 FROM "messages" m WHERE m."target_id" = "targets"."id")) AS has_deps
      FROM "targets"
    ) t
    WINDOW w AS (
      PARTITION BY t."campaign_id", t."linkedin_urn"
      ORDER BY t.has_progress DESC, t.has_deps DESC, t."created_at" ASC, t."id" ASC
    )
  ) ranked
  WHERE rn > 1;--> statement-breakpoint

-- Re-point history from the losers onto the survivor. actions is UNIQUE only on
-- dedup_key and messages has no target_id uniqueness, so these never collide.
UPDATE "actions" SET "target_id" = d.survivor_id
  FROM "_dup_targets" d WHERE "actions"."target_id" = d.loser_id;--> statement-breakpoint
UPDATE "messages" SET "target_id" = d.survivor_id
  FROM "_dup_targets" d WHERE "messages"."target_id" = d.loser_id;--> statement-breakpoint

-- target_progress is UNIQUE(target_id): the survivor already holds the kept
-- cursor (survivor preference put a progress-bearer first), so drop the losers'
-- cursors instead of re-pointing them. The person stays enrolled once, via the
-- survivor.
DELETE FROM "target_progress" WHERE "target_id" IN (SELECT loser_id FROM "_dup_targets");--> statement-breakpoint

DELETE FROM "targets" WHERE "id" IN (SELECT loser_id FROM "_dup_targets");--> statement-breakpoint

DROP TABLE IF EXISTS "_dup_targets";--> statement-breakpoint

CREATE UNIQUE INDEX "targets_campaign_urn_uq" ON "targets" USING btree ("campaign_id","linkedin_urn");--> statement-breakpoint
CREATE INDEX "targets_urn_idx" ON "targets" USING btree ("linkedin_urn");
