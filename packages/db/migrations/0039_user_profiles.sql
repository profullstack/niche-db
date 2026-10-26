-- The shared Profullstack profile: email, first_name, last_name, company_domain,
-- job_title, linkedin_url, owned by @profullstack/profile.
--
-- The package's own table, keyed by users.id. NOT the `profiles` table: that one
-- holds public OpenProfile documents for the people directory, and nothing a
-- person types at signup (their email above all) is ever copied there. DDL is the
-- package's `profile schema --key user_id --key-type uuid` output. No foreign key,
-- as the package documents; deleteAccount removes the row.
create table if not exists "user_profiles" (
  "user_id" uuid primary key,
  "email" text,
  "first_name" text,
  "last_name" text,
  "company_domain" text,
  "job_title" text,
  "linkedin_url" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "user_profiles_email" on "user_profiles" (lower("email"));
create index if not exists "user_profiles_company_domain" on "user_profiles" ("company_domain");

-- The account row is only created when the emailed link is spent, so the fields a
-- signup typed ride on the token until then. Validated before they are stored
-- here, and saved only once the link proves the mailbox.
alter table login_tokens add column if not exists profile jsonb;

-- One-time backfill from users.display_name. First word to first_name, the rest
-- to last_name. Only blanks are filled, so a re-run never overwrites anything.
insert into user_profiles (user_id, email, first_name, last_name)
select
  u.id,
  lower(u.email::text),
  split_part(btrim(u.display_name), ' ', 1),
  nullif(btrim(substr(btrim(u.display_name), length(split_part(btrim(u.display_name), ' ', 1)) + 1)), '')
from users u
where nullif(btrim(u.display_name), '') is not null
on conflict (user_id) do update set
  email      = coalesce(user_profiles.email, excluded.email),
  first_name = coalesce(user_profiles.first_name, excluded.first_name),
  last_name  = coalesce(user_profiles.last_name, excluded.last_name);
