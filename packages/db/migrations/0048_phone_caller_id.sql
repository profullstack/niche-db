-- Caller ID (CNAM) answers for /phone, one row per number, refreshed after 30
-- days. Kept out of `items` on purpose: a caller ID name can be a private
-- person's, so it is never part of a collection, a feed, an export or a
-- sitemap. It is shown only on the number's own page to someone who asked.
create table if not exists phone_caller_id (
  e164 text primary key check (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  caller_name text,
  line_type text,
  carrier text,
  ocn text,
  ported boolean,
  raw jsonb not null default '{}'::jsonb,
  looked_up_at timestamptz not null default now()
);

create index if not exists phone_caller_id_looked_up_at on phone_caller_id (looked_up_at);
