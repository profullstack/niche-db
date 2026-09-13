-- Feeds people ask us to carry.
--
-- Anyone can suggest a URL from any page, signed in or not. Nothing is fetched
-- on a schedule until an admin approves it: a source makes the deployment poll
-- somebody's server four times an hour, and that is the one thing a stranger
-- should not be able to switch on by themselves. A decided row stays as the
-- record of what was asked and what was said; suggesting the same URL again
-- after a decision is a new row, which the partial index allows and a plain
-- unique would not.
create table source_submissions (
  id            bigserial primary key,
  feed_url      text not null,
  -- Where the submitter thinks it belongs. Advisory: the admin picks on approval.
  collection_id bigint references collections(id) on delete set null,
  note          text,
  user_id       uuid references users(id) on delete set null,
  -- For a signed-out submitter who wants to hear back. Never required.
  email         text,
  -- What one bounded look at the URL found at submission time: HTTP status,
  -- content type, whether the first bytes parse as RSS/Atom, the title. For
  -- the admin's eyes; never trusted for anything automatic.
  probe         jsonb not null default '{}',
  status        text not null default 'pending',
  constraint source_submissions_status check (status in ('pending', 'approved', 'rejected')),
  decided_at    timestamptz,
  decided_by    uuid references users(id) on delete set null,
  decision_note text,
  -- What approval produced: the source it became here, or the directory it
  -- was handed to (podcast feeds go to rssamplifier, which this site reads).
  source_id     bigint references sources(id) on delete set null,
  forwarded_to  text,
  created_at    timestamptz not null default now()
);
create index source_submissions_status_idx on source_submissions (status, created_at desc);
create index source_submissions_user_idx on source_submissions (user_id, created_at desc);
create unique index source_submissions_one_open on source_submissions (feed_url) where status = 'pending';
