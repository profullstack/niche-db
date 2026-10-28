-- Webhooks through @profullstack/webhooks: one durable outbox (endpoints +
-- deliveries, retried with backoff in the table, not in BullMQ) for both kinds
-- of webhook this site sends.
--
--  * Account endpoints (/api/v1/webhooks, /settings): owner = users.id as text,
--    standard Standard Webhooks signing with a generated whsec_ secret.
--  * Follow webhooks (a follow's webhook_url + webhook_secret): mirrored into
--    one endpoint per follow, id 'whf_<feed id>_<user id, no dashes>', owner
--    'follow:<user id>:<feed id>', so the follow form, API and MCP keep working
--    unchanged and a follow's items never reach another follow's URL.
--
-- The DDL is the package's own schemaSql('pg'), unchanged, so the store and
-- this file can never disagree about a column.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_owner ON webhook_endpoints(owner);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at);

-- Every existing follow webhook becomes its endpoint, keeping its URL and its
-- secret's KEY BYTES. @profullstack/autoblog keyed the HMAC with the whole
-- secret string as UTF-8, while @profullstack/webhooks decodes the base64
-- after a whsec_ prefix -- and the follow form suggested "whsec_…". So the
-- secret is stored as whsec_ + base64(the old string): the same key bytes for
-- every secret, whatever it looks like, and every receiver keeps verifying.
-- (Postgres base64 wraps at 76 characters; the newlines are removed.)
INSERT INTO webhook_endpoints (id, owner, url, secret, events, description, enabled, failures, disabled_reason, created_at, updated_at)
SELECT 'whf_' || f.feed_id || '_' || replace(f.user_id::text, '-', ''),
       'follow:' || f.user_id::text || ':' || f.feed_id,
       f.webhook_url,
       'whsec_' || replace(encode(convert_to(f.webhook_secret, 'UTF8'), 'base64'), E'\n', ''),
       '["*"]',
       'follow of ' || fe.slug,
       1, 0, NULL,
       (extract(epoch from f.created_at) * 1000)::bigint,
       (extract(epoch from now()) * 1000)::bigint
FROM follows f
JOIN feeds fe ON fe.id = f.feed_id
WHERE f.webhook_url IS NOT NULL
  AND f.webhook_secret IS NOT NULL
  AND 'webhook' = ANY (f.channels)
ON CONFLICT (id) DO NOTHING;
