-- The seller side: who may be paid for the writing in this index.
--
-- Everything here is somebody's work, and training crawlers are most of what
-- reads it. These three tables are how the people whose work it is get paid a
-- share of what a crawler pays for access (@profullstack/partners).
--
-- The DDL matches the package's own `sqlStore({ dialect: 'postgres' }).schema`
-- exactly, and lives here as a numbered migration rather than running at boot,
-- so schema changes arrive the same way as every other one on this database.
create table if not exists partner_accounts (
  id             bigserial primary key,
  user_id        text not null unique,
  name           text,
  -- A comma-joined list, which is the package's storage shape. Every read goes
  -- through it, so nothing here parses this column by hand.
  niches         text not null default '',
  payout_address text,
  created_at     bigint not null default (extract(epoch from now()) * 1000)
);

-- `domain` is unique across every partner, not per partner: two accounts
-- claiming the same site is the shape of one person being paid for another's
-- work, so the database refuses it rather than the application remembering to.
create table if not exists partner_properties (
  id          bigserial primary key,
  partner_id  text not null,
  domain      text not null unique,
  verified_at bigint,
  method      text,
  created_at  bigint not null default (extract(epoch from now()) * 1000)
);
create index if not exists partner_properties_partner on partner_properties (partner_id);

-- `ref` is unique so a settlement delivered twice pays once. Credits outlive
-- the property that earned them: removing a site does not erase its earnings.
create table if not exists partner_credits (
  id         bigserial primary key,
  partner_id text not null,
  cents      bigint not null,
  ref        text unique,
  at         bigint not null
);
create index if not exists partner_credits_partner on partner_credits (partner_id);
