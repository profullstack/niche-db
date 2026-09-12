-- Premium: the membership a person buys, the credits it grants, and the awards
-- those credits are spent on.
--
-- `memberships` already held one paid term per row and every one of them meant
-- Pro, because Pro was the only thing to buy. A plan column with a default of
-- 'pro' therefore says exactly what the existing rows already meant, and no
-- backfill is needed or wanted.

alter table memberships add column if not exists plan text not null default 'pro';
-- `add constraint if not exists` does not exist, and a migration that cannot be
-- re-run by hand is a migration somebody will eventually run twice by hand.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'memberships_plan_check') then
    alter table memberships add constraint memberships_plan_check check (plan in ('premium', 'pro'));
  end if;
end $$;
create index if not exists memberships_plan_idx on memberships (user_id, plan, expires_at desc);

-- What a member chose to look at. Two scalar columns rather than a jsonb blob:
-- both are single values from a fixed list, and a jsonb write here would need
-- the ::text::jsonb cast this codebase has been bitten by twice.
alter table users add column if not exists premium_theme text;
alter table users add column if not exists premium_icon text;

-- The credit ledger. Append-only: a grant is a positive row, a spend is a
-- negative one, and the balance is the sum. Nothing is ever updated, so a
-- disputed balance can be read back event by event.
--
-- `ref` is what makes a grant idempotent. The monthly grant is keyed by its
-- month ('grant:2026-09'), so running the granter twice in September inserts
-- once; the unique index is the guard, not the code around it.
create table if not exists premium_credits (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  delta      int not null,
  reason     text not null,
  ref        text,
  created_at timestamptz not null default now()
);
create index if not exists premium_credits_user_idx on premium_credits (user_id, created_at desc);
create unique index if not exists premium_credits_ref_idx
  on premium_credits (user_id, ref) where ref is not null;

-- An award: one member spending credits to mark one thing as worth reading.
--
-- The target is (type, id) rather than two nullable foreign keys because the
-- two things that can be awarded live in different tables and a third will
-- arrive. The pair is unique per giver, so awarding the same item the same way
-- twice is one award and one charge.
create table if not exists premium_awards (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  target_type text not null check (target_type in ('item', 'contribution')),
  target_id   bigint not null,
  kind        text not null,
  credits     int not null,
  created_at  timestamptz not null default now(),
  unique (user_id, target_type, target_id, kind)
);
create index if not exists premium_awards_target_idx
  on premium_awards (target_type, target_id, created_at desc);

-- Early access: a collection that members can see and the public cannot, yet.
--
-- Off everywhere. A collection is opened to members by setting this, and made
-- public by clearing it; nothing is hidden by this migration, so the site after
-- it is exactly the site before it.
alter table collections add column if not exists early_access boolean not null default false;
