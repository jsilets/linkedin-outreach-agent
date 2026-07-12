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

-- 4. Drop only childless duplicate targets per (campaign_id, bare urn). The
--    survivor is the row that carries dependents (enrollment / actions /
--    messages), else the oldest. A residual collision of two dependent-bearing
--    rows is left for the unique index below to reject loudly rather than
--    silently merged — no enrollment is ever deleted.
DELETE FROM "targets" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT t."id",
      (EXISTS (SELECT 1 FROM "target_progress" tp WHERE tp."target_id" = t."id")
        OR EXISTS (SELECT 1 FROM "actions" a WHERE a."target_id" = t."id")
        OR EXISTS (SELECT 1 FROM "messages" m WHERE m."target_id" = t."id")) AS has_deps,
      row_number() OVER (
        PARTITION BY t."campaign_id", t."linkedin_urn"
        ORDER BY
          (EXISTS (SELECT 1 FROM "target_progress" tp WHERE tp."target_id" = t."id")
            OR EXISTS (SELECT 1 FROM "actions" a WHERE a."target_id" = t."id")
            OR EXISTS (SELECT 1 FROM "messages" m WHERE m."target_id" = t."id")) DESC,
          t."created_at" ASC, t."id" ASC
      ) AS rn
    FROM "targets" t
  ) ranked
  WHERE rn > 1 AND has_deps = false
);--> statement-breakpoint

CREATE UNIQUE INDEX "targets_campaign_urn_uq" ON "targets" USING btree ("campaign_id","linkedin_urn");--> statement-breakpoint
CREATE INDEX "targets_urn_idx" ON "targets" USING btree ("linkedin_urn");
