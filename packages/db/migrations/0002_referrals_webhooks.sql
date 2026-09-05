-- Referral codes (via @profullstack/referrals) and webhook delivery for feeds
-- (via @profullstack/autoblog, CloudEvents + Standard Webhooks).

create table if not exists referral_codes (
  code        text primary key,
  owner_id    uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  split       jsonb
);
create index if not exists referral_codes_owner_idx on referral_codes (owner_id);

create table if not exists referral_usages (
  id               bigserial primary key,
  code             text not null references referral_codes(code) on delete cascade,
  affiliate_id     uuid not null references users(id) on delete cascade,
  new_user_id      uuid not null references users(id) on delete cascade,
  amount_cents     int not null,
  commission_cents int not null,
  discount_cents   int not null,
  applied_at       timestamptz not null default now(),
  -- One referral per new customer: the discount is for a first purchase.
  unique (new_user_id)
);
create index if not exists referral_usages_affiliate_idx on referral_usages (affiliate_id);

-- Which code brought an account here, captured at sign-up and spent at first purchase.
alter table users add column if not exists referred_by text references referral_codes(code) on delete set null;

-- A follow may also POST each new item to a URL, signed. The secret is shown
-- once and stored as given: it is the receiver's secret, not ours to hash.
alter table follows add column if not exists webhook_url    text;
alter table follows add column if not exists webhook_secret text;
