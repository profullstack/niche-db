-- Data membership includes Pro and adds access to hourly public-data snapshots.
alter table memberships drop constraint if exists memberships_plan_check;
alter table memberships add constraint memberships_plan_check
  check (plan in ('premium', 'pro', 'data'));

-- Only complete manifests are published. Object keys never contain account data.
create table if not exists data_dumps (
  id uuid primary key,
  snapshot_at timestamptz not null,
  completed_at timestamptz not null default now(),
  manifest jsonb not null
);
create index if not exists data_dumps_latest_idx on data_dumps (snapshot_at desc);
