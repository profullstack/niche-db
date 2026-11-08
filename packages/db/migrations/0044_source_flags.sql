-- The fleet crawler rule (2026-11-08): a source whose upstream was slow or
-- broken (timeout, DNS/TLS/connection error, HTTP 5xx) is flagged and left
-- alone for 30 days (next_run_at), then tried once. `flag` is 'slow' or
-- 'broken' while that holds, `flagged_at` when it was set (the failure time);
-- both clear on the next run that ends any other way. Boot's
-- rescheduleFailedSources skips flagged rows, or every deploy would undo it.
--
-- sources is small (hundreds of rows) and both columns are nullable with no
-- default, so this is a catalogue change, not a rewrite. lock_timeout keeps a
-- busy worker from holding the deploy: the migration fails and retries.
set local lock_timeout = '10s';

alter table sources
  add column if not exists flag text check (flag in ('slow', 'broken')),
  add column if not exists flagged_at timestamptz;
