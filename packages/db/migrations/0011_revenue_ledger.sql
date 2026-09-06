-- The revenue ledger: what a niche earned, whose share of it is whose, and
-- what has been paid out.
--
-- Until now a Knowledge Influencer could climb to 80% and the number was a
-- label on a page. These tables are what stands behind it.
--
-- Two rules shape everything here. Money is integer minor units and shares are
-- integer basis points, because a share of a dollar computed in floating point
-- is a share that does not add up. And an allocation records the share that
-- was in force when the event was finalised: reaching Expert tomorrow does not
-- reach back and re-pay yesterday's sale at 40%.

-- One earning. Gross in, what it cost to take it, and the remainder that is
-- actually shared.
create table revenue_events (
  id                 bigserial primary key,
  -- The payment reference this came in on. Unique, so a settlement delivered
  -- twice books once, which is the only thing standing between a retried
  -- webhook and paying somebody twice.
  external_id        text unique,
  -- Null when the money is not attributable to a niche. It is kept, and goes
  -- entirely to the platform. Deleting a niche must never delete the record of
  -- money that moved, so this detaches rather than cascades.
  niche_id           bigint references niches(id) on delete set null,
  source_type        text not null,
  constraint revenue_events_source check (source_type in (
    'software_subscription', 'software_one_time', 'api', 'x402', 'dataset_license',
    'lead', 'sponsorship', 'affiliate', 'referral', 'advertising', 'service', 'other')),
  source_id          text,
  gross_amount_minor  bigint not null,
  direct_cost_minor   bigint not null default 0,
  net_amount_minor    bigint not null,
  -- The arithmetic is a constraint rather than a convention. A row whose parts
  -- do not add up cannot be written at all, so no reader has to re-check it.
  constraint revenue_events_adds_up
    check (net_amount_minor = gross_amount_minor - direct_cost_minor),
  constraint revenue_events_non_negative
    check (gross_amount_minor >= 0 and direct_cost_minor >= 0 and net_amount_minor >= 0),
  currency           text not null default 'USD',
  occurred_at        timestamptz not null default now(),
  -- Nothing is allocated until this is set, and it is set once. Allocation
  -- happens AT finalisation and reads the shares as they are at that instant.
  finalized_at       timestamptz,
  metadata           jsonb not null default '{}',
  created_at         timestamptz not null default now()
);
create index revenue_events_niche_idx on revenue_events (niche_id, occurred_at desc);
create index revenue_events_pending_idx on revenue_events (occurred_at) where finalized_at is null;

-- Who gets what out of one event. Written once, at finalisation, and never
-- updated when somebody's tier moves afterwards.
create table revenue_allocations (
  id                bigserial primary key,
  revenue_event_id  bigint not null references revenue_events(id) on delete cascade,
  -- Null for the platform's own share.
  influencer_id     uuid references users(id) on delete set null,
  allocation_type   text not null,
  constraint revenue_allocations_type check (allocation_type in (
    'knowledge_influencer', 'platform', 'specialist', 'partner')),
  -- The share as it stood when this was written. This column is the whole
  -- reason "your share was 40% when that settled" is checkable months later.
  share_bps         int not null,
  constraint revenue_allocations_bps check (share_bps between 0 and 10000),
  amount_minor      bigint not null,
  constraint revenue_allocations_non_negative check (amount_minor >= 0),
  -- accrued -> eligible -> scheduled -> processing -> paid, or failed/reversed.
  status            text not null default 'accrued',
  constraint revenue_allocations_status check (status in (
    'accrued', 'eligible', 'scheduled', 'processing', 'paid', 'failed', 'reversed')),
  created_at        timestamptz not null default now()
);
create index revenue_allocations_event_idx on revenue_allocations (revenue_event_id);
create index revenue_allocations_owed_idx
  on revenue_allocations (influencer_id, status) where influencer_id is not null;
-- One allocation per party per event. Re-running allocation on an event that
-- somehow escaped its finalisation guard still cannot pay anyone twice.
create unique index revenue_allocations_once
  on revenue_allocations (revenue_event_id, allocation_type,
    coalesce(influencer_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Where somebody's money goes. Separate from the user row because an address
-- is a thing an admin checks, and because most accounts never have one.
create table payout_accounts (
  id          bigserial primary key,
  user_id     uuid not null unique references users(id) on delete cascade,
  address     text,
  currency    text not null default 'USD',
  -- Payouts refuse an address nobody has confirmed. Paying the wrong address
  -- is not recoverable, so this is a deliberate human step.
  verified_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One disbursement.
--
-- Nothing here sends money. CoinPay's payout API pays a connected merchant
-- account (us), not an arbitrary third-party address, so settlement is done
-- out of band and recorded here with its reference. That is the same shape the
-- partner programme uses: accrue accurately, pay deliberately.
create table payouts (
  id             bigserial primary key,
  influencer_id  uuid not null references users(id) on delete cascade,
  amount_minor   bigint not null,
  constraint payouts_positive check (amount_minor > 0),
  currency       text not null default 'USD',
  status         text not null default 'scheduled',
  constraint payouts_status check (status in (
    'scheduled', 'processing', 'paid', 'failed', 'reversed')),
  -- The reference from whatever actually moved the money.
  external_ref   text unique,
  failure_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  paid_at        timestamptz
);
create index payouts_influencer_idx on payouts (influencer_id, created_at desc);

-- Which allocations a payout covers.
--
-- `allocation_id` is the primary key on its own, and that is the point: an
-- allocation can belong to at most one payout, so the database refuses to pay
-- the same earning twice however many times someone presses the button.
create table payout_allocations (
  payout_id     bigint not null references payouts(id) on delete cascade,
  allocation_id bigint not null references revenue_allocations(id) on delete restrict,
  primary key (allocation_id)
);
create index payout_allocations_payout_idx on payout_allocations (payout_id);
