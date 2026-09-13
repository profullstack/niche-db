-- OpenSaaS (logicsrc.com/opensaas): the way out, made real.
--
-- A cancelled term keeps its row with the moment it was cut short, so the
-- ledger still says what was bought and the plan check says it ended. Account
-- deletion is confirmed by a one-time link, stored the way a magic link is:
-- only the hash, so a database read cannot delete an account.

alter table memberships add column if not exists cancelled_at timestamptz;

create table if not exists account_actions (
  token_hash  bytea primary key,
  user_id     uuid not null references users(id) on delete cascade,
  action      text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
create index if not exists account_actions_user_idx on account_actions (user_id, action);
