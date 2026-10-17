-- Bad traffic: IP addresses our own servers banned, published only after a
-- person has looked at the evidence and agreed.
--
-- ThreatCrush runs on every box in the fleet and bans an address when it
-- probes for exploits, scans for admin panels, tries path traversal or SQL
-- injection, or brute-forces SSH. Those bans are automatic and some are wrong
-- (a misread port scan once banned our own upstreams; the busiest "scraper" in
-- one sweep was real Googlebot), so nothing is published on the machine's say
-- alone. Every address arrives here `pending` with its evidence; a reviewer
-- marks it `approved` or `rejected`, and only approved rows are served.
--
-- A later import refreshes the evidence (last seen, how many boxes, which
-- rules) but never changes a decision: a rejected address stays rejected
-- however often it comes back, and an approved one stays approved.

create table if not exists traffic_ips (
  ip            inet primary key,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  -- Higher is stronger evidence; the review queue is worked in this order.
  score         integer not null default 0,
  category      text,
  first_seen    timestamptz,
  last_seen     timestamptz,
  blocks        integer not null default 0,
  servers       integer not null default 0,
  rules         jsonb not null default '[]'::jsonb,
  max_severity  text,
  evidence      jsonb not null default '{}'::jsonb,
  reviewed_by   uuid references users(id) on delete set null,
  reviewed_at   timestamptz,
  review_note   text check (review_note is null or length(review_note) <= 1000),
  imported_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists traffic_ips_published on traffic_ips (status, reviewed_at desc);
create index if not exists traffic_ips_queue on traffic_ips (status, score desc, last_seen desc);

create table if not exists traffic_sync (
  source      text primary key,
  fetched_at  timestamptz,
  count       integer,
  added       integer,
  error       text
);
