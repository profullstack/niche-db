-- Knowledge Influencers: the people who know an industry, supervising the
-- agents that build software and data for it.
--
-- The seller side (0006_partners) pays someone for writing that already
-- exists and got crawled. This is the other half: someone who has no site to
-- verify, only years of knowing how a business actually works, and who earns
-- a rising share of what the niche they operate makes. Two different programs
-- that both cap at 80%, kept in separate tables because conflating a
-- commission on someone else's traffic with a share of a business you help
-- run makes both impossible to audit.
--
-- Numbered 0007 with 0006 reserved for the partners branch still in flight:
-- two branches adding the same number merge cleanly and then nobody knows
-- which ran first.

-- A niche is a bounded market: commercial-roofing, dental-practices. Not the
-- same thing as a `collection`, which is a shape of data this deployment
-- ingests. A niche may grow into one, so it can point at one, but most niches
-- start as a market with an opportunity and no rows at all.
create table niches (
  id                 bigserial primary key,
  slug               text not null unique,
  -- The niche's page lives at the site root (/commercial-roofing), so a slug
  -- that collides with a real route would shadow it. The application refuses
  -- reserved words on the way in; this check is the floor under that, because
  -- a niche named `settings` is a bug nobody notices until sign-in breaks.
  constraint niches_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name               text not null,
  description        text,
  -- draft: not public yet. open: public, no operator, claimable.
  -- operated: has at least one active member. archived: hidden, kept for history.
  status             text not null default 'open',
  constraint niches_status check (status in ('draft', 'open', 'operated', 'archived')),
  -- The data collection this niche feeds, when it has grown one.
  collection_id      bigint references collections(id) on delete set null,
  -- 0-100, explainable: the dimensions behind it live in opportunities.
  opportunity_score  int,
  -- A logical identifier (`chovy-niche-commercial-roofing`), not a deployed
  -- service. Phase 2 attaches the agent; the column exists now so the page
  -- that shows an operator does not need a migration to show their agent.
  primary_agent_id   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index niches_status_idx on niches (status);
create index niches_opportunity_idx on niches (opportunity_score desc nulls last);
create index niches_collection_idx on niches (collection_id);

-- Who operates a niche, and the ceiling on what they may earn from it.
--
-- `share_cap_bps` is per member and defaults to the program maximum. It exists
-- so a niche with several people in it can be capped below the maximum
-- individually without editing the tier table, which is global.
create table niche_members (
  id             bigserial primary key,
  niche_id       bigint not null references niches(id) on delete cascade,
  user_id        uuid not null references users(id) on delete cascade,
  -- operator: the Knowledge Influencer. specialist: a narrower contributor.
  -- observer: can see the dashboard, earns nothing.
  role           text not null default 'operator',
  constraint niche_members_role check (role in ('operator', 'specialist', 'observer')),
  status         text not null default 'active',
  constraint niche_members_status check (status in ('pending', 'active', 'suspended', 'left')),
  -- Basis points, never a float: 8000 is 80%. Money and shares are integers
  -- everywhere in this schema for the same reason.
  share_cap_bps  int not null default 8000,
  constraint niche_members_cap check (share_cap_bps between 0 and 8000),
  joined_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (niche_id, user_id)
);
create index niche_members_niche_idx on niche_members (niche_id, status);
create index niche_members_user_idx on niche_members (user_id, status);

-- Why a niche is worth operating, in dimensions rather than one number, so
-- the score on the card can be explained on the page instead of asserted.
create table opportunities (
  id           bigserial primary key,
  niche_id     bigint not null unique references niches(id) on delete cascade,
  -- The published headline number, 0-100. Recomputed from `dimensions`.
  score        int,
  constraint opportunities_score check (score is null or score between 0 and 100),
  -- { software_gap: 80, search_demand: 60, ... }. Absent dimensions are
  -- absent, not zero: a niche nobody has measured for machine demand should
  -- say so rather than score itself badly for it.
  dimensions   jsonb not null default '{}',
  -- The bullet list under "Why it matters", authored or generated.
  rationale    text,
  status       text not null default 'open',
  constraint opportunities_status check (status in ('open', 'claimed', 'closed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index opportunities_score_idx on opportunities (score desc nulls last) where status = 'open';

-- Someone asking to operate a niche. Kept apart from niche_members so a
-- rejected application leaves a record and a resubmission is a new row.
create table niche_claims (
  id           bigserial primary key,
  niche_id     bigint not null references niches(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  -- The onboarding answers, question key to answer. Free text, shown to an
  -- admin, never interpolated into anything an agent executes.
  answers      jsonb not null default '{}',
  status       text not null default 'pending',
  constraint niche_claims_status check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_at   timestamptz,
  decided_by   uuid references users(id) on delete set null,
  decision_note text,
  created_at   timestamptz not null default now()
);
create index niche_claims_niche_idx on niche_claims (niche_id, status);
create index niche_claims_user_idx on niche_claims (user_id, created_at desc);
-- One live application per person per niche. A decided one does not block a
-- new attempt, which is what the partial index buys over a plain unique.
create unique index niche_claims_one_open on niche_claims (niche_id, user_id) where status = 'pending';

-- The tier table: score in, share out. Data rather than code so the ladder
-- can be tuned without a deploy, seeded from packages/knowledge/src/tiers.js
-- and read back through it.
create table contribution_tiers (
  slug       text primary key,
  name       text not null,
  min_score  int not null,
  share_bps  int not null,
  constraint contribution_tiers_bps check (share_bps between 0 and 8000),
  position   int not null
);

-- Every scored thing a human did. Rows are never deleted and never lose their
-- points: an event that should not have counted is marked `reversed` and the
-- sum stops including it, so the history of how someone reached 80% survives
-- the correction and a dispute has something to read.
create table contribution_events (
  id           bigserial primary key,
  niche_id     bigint not null references niches(id) on delete cascade,
  influencer_id uuid not null references users(id) on delete cascade,
  event_type   text not null,
  -- What the engine awarded, after weighting and any diminishing return.
  points       int not null default 0,
  -- pending: awarded nothing yet. verified: counts. rejected: never counted.
  -- reversed: counted once, then taken back; keeps its points, leaves the sum.
  status       text not null default 'pending',
  constraint contribution_events_status check (status in ('pending', 'verified', 'rejected', 'reversed')),
  source_type  text,
  source_id    text,
  -- What makes this claim checkable: the answer, the diff, the link, the
  -- payment reference. Crawled or user-supplied text lives here as data.
  evidence     jsonb not null default '{}',
  -- Set by the engine when the same work is submitted twice. The digest is
  -- over the niche, the type and the substance, so a duplicate is worth zero
  -- rather than worth points again.
  dedupe_key   text,
  created_at   timestamptz not null default now(),
  verified_at  timestamptz,
  verified_by  uuid references users(id) on delete set null,
  -- The event this one reverses, when it is a reversal.
  reverses_id  bigint references contribution_events(id) on delete set null
);
create index contribution_events_niche_user_idx
  on contribution_events (niche_id, influencer_id, created_at desc);
create index contribution_events_status_idx on contribution_events (status, created_at desc);
create index contribution_events_type_idx on contribution_events (niche_id, event_type);
-- A submission delivered twice books once. Partial, because a null key (an
-- event with no natural identity, like a manual adjustment) must not collide.
create unique index contribution_events_dedupe
  on contribution_events (niche_id, influencer_id, dedupe_key)
  where dedupe_key is not null;

-- The running total, one row per person per niche. Derivable from the events
-- by summation, kept because the dashboard, the public profile and the tier
-- check all want it on every request and the event table only grows.
create table contribution_scores (
  niche_id      bigint not null references niches(id) on delete cascade,
  influencer_id uuid not null references users(id) on delete cascade,
  score         int not null default 0,
  verified_count int not null default 0,
  pending_count  int not null default 0,
  tier_slug     text not null references contribution_tiers(slug),
  share_bps     int not null default 2000,
  updated_at    timestamptz not null default now(),
  primary key (niche_id, influencer_id)
);
create index contribution_scores_board_idx on contribution_scores (niche_id, score desc);

-- Every tier a person has held, with the score and the reason. Append-only:
-- this is what makes "your share was 40% when that sale settled" checkable
-- months later, and it is why a tier change never rewrites an old allocation.
create table tier_history (
  id            bigserial primary key,
  niche_id      bigint not null references niches(id) on delete cascade,
  influencer_id uuid not null references users(id) on delete cascade,
  tier_slug     text not null references contribution_tiers(slug),
  score         int not null,
  share_bps     int not null,
  effective_at  timestamptz not null default now(),
  reason        text
);
create index tier_history_lookup_idx
  on tier_history (niche_id, influencer_id, effective_at desc);

-- Admin mutations, in the order they happened. Every verify, reject, reversal
-- and manual adjustment lands here: the program pays real money on the
-- strength of these decisions, so who made one has to outlive the session
-- that made it.
create table knowledge_audit_logs (
  id         bigserial primary key,
  actor_id   uuid references users(id) on delete set null,
  action     text not null,
  subject_type text not null,
  subject_id text,
  niche_id   bigint references niches(id) on delete set null,
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index knowledge_audit_logs_at_idx on knowledge_audit_logs (created_at desc);
create index knowledge_audit_logs_subject_idx on knowledge_audit_logs (subject_type, subject_id);

-- The ladder as shipped. `on conflict do nothing` so a deployment that has
-- already tuned its own thresholds is not reset by a re-run.
insert into contribution_tiers (slug, name, min_score, share_bps, position) values
  ('contributor',              'Contributor',                 0, 2000, 1),
  ('specialist',               'Specialist',                100, 3000, 2),
  ('expert',                   'Expert',                    250, 4000, 3),
  ('lead-expert',              'Lead Expert',               500, 5000, 4),
  ('niche-operator',           'Niche Operator',            900, 6000, 5),
  ('senior-operator',          'Senior Operator',          1500, 7000, 6),
  ('top-knowledge-influencer', 'Top Knowledge Influencer', 2500, 8000, 7)
on conflict (slug) do nothing;
