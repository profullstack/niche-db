-- Delisting requests for /traffic: the owner of a listed address says it is
-- theirs and why it should come off. A reviewer reads it beside the evidence
-- and either takes the address off the list (rejects it, which also keeps it
-- off for good) or declines with a note. The requester's email is kept for
-- the reviewer only and never shown publicly.

create table if not exists traffic_delist_requests (
  id           bigserial primary key,
  ip           inet not null,
  email        text not null check (length(email) <= 320),
  reason       text not null check (length(reason) between 10 and 2000),
  status       text not null default 'open' check (status in ('open', 'delisted', 'declined')),
  created_at   timestamptz not null default now(),
  decided_by   uuid references users(id) on delete set null,
  decided_at   timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000)
);
create index if not exists traffic_delist_open on traffic_delist_requests (status, created_at);
