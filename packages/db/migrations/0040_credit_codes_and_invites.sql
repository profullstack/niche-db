-- Redeemable credit codes and scarce invites (@profullstack/redeem-credits,
-- @profullstack/affiliates), on the same Postgres as everything else.
--
-- Both packages' postgresStore would create these tables on first use; they
-- are here so the schema arrives the repo's way, in one reviewed migration,
-- and the runtime CREATE ... IF NOT EXISTS is a no-op. The DDL is the
-- packages' own output (redeem-credits schemaSql('pg', 'credit_') and
-- affiliates ddl('aff_', 'postgres')), unchanged, so the stores and this file
-- can never disagree about a column. User ids are text there: they hold
-- users.id as a uuid string.
--
-- What a code or an invite GRANTS is not stored here. It goes through the
-- path a paid Premium term already takes, a memberships row (see grant_ref
-- below), so there is one entitlement and no parallel flag.

-- @profullstack/redeem-credits: codes (sha256 only), redemptions, ledger, accounts.
CREATE TABLE IF NOT EXISTS credit_codes (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  recur TEXT,
  months INTEGER,
  max_redemptions INTEGER NOT NULL,
  redemptions INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS credit_redemptions (
  code_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (code_id, user_id)
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  kind TEXT NOT NULL,
  recur TEXT,
  months INTEGER,
  source TEXT NOT NULL,
  at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS credit_ledger_user_unit ON credit_ledger (user_id, unit, at);

CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, unit)
);
-- @profullstack/affiliates: invites, quotas, affiliate codes, attributions.
CREATE TABLE IF NOT EXISTS aff_invites (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      inviter_id TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT,
      used_by TEXT,
      used_at BIGINT,
      note TEXT NOT NULL DEFAULT '',
      revoked_at BIGINT
    );

CREATE INDEX IF NOT EXISTS aff_invites_inviter_idx ON aff_invites (inviter_id);

CREATE INDEX IF NOT EXISTS aff_invites_used_by_idx ON aff_invites (used_by);

CREATE TABLE IF NOT EXISTS aff_quotas (
      user_id TEXT PRIMARY KEY,
      total INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS aff_codes (
      user_id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL
    );

CREATE TABLE IF NOT EXISTS aff_attributions (
      user_id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL,
      code TEXT NOT NULL,
      at BIGINT NOT NULL
    );

CREATE INDEX IF NOT EXISTS aff_attributions_affiliate_idx ON aff_attributions (affiliate_id);

CREATE OR REPLACE FUNCTION aff_insert_invite(
            p_id TEXT, p_hash TEXT, p_inviter TEXT, p_created BIGINT, p_expires BIGINT, p_note TEXT, p_limit INTEGER
          ) RETURNS BOOLEAN LANGUAGE plpgsql AS $fn$
          BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('aff_invites'), hashtext(p_inviter));
            IF (SELECT count(*) FROM aff_invites
                WHERE inviter_id = p_inviter AND (revoked_at IS NULL OR used_by IS NOT NULL)) >= p_limit THEN
              RETURN FALSE;
            END IF;
            INSERT INTO aff_invites (id, code_hash, inviter_id, created_at, expires_at, note)
              VALUES (p_id, p_hash, p_inviter, p_created, p_expires, p_note);
            RETURN TRUE;
          END
          $fn$;

-- A free term (a redeemed code, an invite bonus) has no payment row, so
-- payment_id cannot make it idempotent. grant_ref does: 'code:<id>',
-- 'invite:<id>:invitee', 'invite:<id>:inviter'. One grant per user per ref,
-- decided by the index, so a retried hook cannot add a second term.
alter table memberships add column if not exists grant_ref text;
create unique index if not exists memberships_grant_ref_idx
  on memberships (user_id, grant_ref) where grant_ref is not null;

-- The invite a sign-up came with rides on the emailed link, like the signup
-- profile does (0039): the account only exists once the link is spent, and the
-- link may be opened in another browser that never saw the invite cookie.
alter table login_tokens add column if not exists invite_code text;
