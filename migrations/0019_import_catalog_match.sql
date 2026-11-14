-- B57-007: the catalog match result of a finished import lives beside its preview, never inside it. The job poll
-- (GET /api/import/jobs/:id) returns preview_json to every client, and clients that sync the preview (mobile <= 1.2.0 (56),
-- the web app) would otherwise push the match result into the account's synced importPreviews, where a newer app could never
-- drop it again (sync loss guard). Additive, nullable, no backfill; erased with the job / account like every import_jobs column.
ALTER TABLE import_jobs ADD COLUMN catalog_match_json TEXT;
