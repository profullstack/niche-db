-- Sign in with CoinPay. A CoinPay identity (its OIDC `sub`) is bound to exactly
-- one account here and that binding is the only thing a CoinPay sign-in trusts.
-- CoinPay never verifies email addresses, so its email is contact information:
-- it is never matched against users.email. A first CoinPay sign-in makes a new
-- account whose users.email is an unroutable <sub>@coinpay.nichedb.invalid;
-- an existing account gets CoinPay only by connecting it from a signed-in session.
create table if not exists coinpay_identities (
  sub           text primary key,
  user_id       uuid not null unique references users(id) on delete cascade,
  email         text,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
