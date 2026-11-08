-- The fleet crawler rule (2026-11-08): a source whose upstream was slow or
-- broken (timeout, DNS/TLS/connection error, HTTP 5xx) is flagged and left
-- alone for 30 days (sources.next_run_at), then tried once. A row here says
-- so: `flag` is 'slow' or 'broken', `flagged_at` the failure time; finishRun
-- deletes it on the next run that ends any other way. Boot's
-- rescheduleFailedSources skips flagged sources, or every deploy would undo it.
--
-- A side table, not columns on sources: ALTER TABLE sources needs an ACCESS
-- EXCLUSIVE lock, and the web's long collection queries hold ACCESS SHARE on
-- sources for minutes at a time, so the first deploy of this hit its
-- lock_timeout five times and never applied. No foreign key for the same
-- reason (adding one locks sources too); a deleted source's row is harmless
-- and finishRun is the only writer.
create table if not exists source_flags (
  source_id integer primary key,
  flag text not null check (flag in ('slow', 'broken')),
  flagged_at timestamptz not null default now()
);
