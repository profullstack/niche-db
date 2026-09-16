-- Production creates this concurrently before rollout to avoid blocking writes.
-- The index makes rolling-day page statistics independent of total item history.
create index if not exists items_first_seen_idx on items (first_seen_at);
