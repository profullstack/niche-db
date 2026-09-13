/**
 * Applying to moderate, and what a moderator may then do with the queue,
 * over fake stores. What would be embarrassing: a stranger applying, a
 * member applying twice, a moderator approving into somebody else's
 * collection, a moderator seeing suggestions that are not theirs, a
 * non-admin deciding who moderates.
 */
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const NICHE = {
  id: 7,
  slug: 'roofing',
  name: 'Roofing',
  status: 'open',
  collection_slug: 'roofing-data',
};
const knowledge = {
  claims: [],
  members: {},
  async getNiche(slug) {
    return slug === 'roofing' ? { ...NICHE } : null;
  },
  async memberOf({ userId }) {
    return knowledge.members[userId] ?? null;
  },
  async listClaims({ userId }) {
    return knowledge.claims.filter((c) => c.user_id === userId && c.status === 'pending');
  },
  async nicheMembers() {
    return [
      {
        user_id: 'u-mod',
        role: 'moderator',
        status: 'active',
        handle: 'mo',
        display_name: 'Mo',
        tier_slug: 'contributor',
        share_bps: 0,
        verified_count: 0,
      },
    ];
  },
  async createClaim({ nicheId, userId, answers, role }) {
    if (
      knowledge.claims.some(
        (c) => c.user_id === userId && c.niche_id === nicheId && c.status === 'pending',
      )
    )
      return null;
    const claim = {
      id: knowledge.claims.length + 1,
      niche_id: nicheId,
      user_id: userId,
      answers,
      role,
      status: 'pending',
    };
    knowledge.claims.push(claim);
    return claim;
  },
  async moderatedNiches(userId) {
    return userId === 'u-mod'
      ? [{ id: 7, slug: 'roofing', name: 'Roofing', collection_slug: 'roofing-data' }]
      : [];
  },
  async moderatesAny(userId) {
    return userId === 'u-mod';
  },
  async influencerByHandle() {
    return null;
  },
  async listContributions() {
    return [];
  },
  async listAudit() {
    return [];
  },
  async decideClaim() {
    return null;
  },
};
// The real module underneath, so every name other modules import by name still resolves.
const realKnowledge = await import('@nichedb/db/knowledge');
mock.module('@nichedb/db/knowledge', () => ({ ...realKnowledge, ...knowledge }));

const submissions = [
  {
    id: 1,
    status: 'pending',
    feed_url: 'https://a.example/feed',
    collection_slug: 'roofing-data',
    created_at: new Date().toISOString(),
  },
  {
    id: 2,
    status: 'pending',
    feed_url: 'https://b.example/feed',
    collection_slug: 'news',
    created_at: new Date().toISOString(),
  },
];
const subs = {
  decided: [],
  async listSubmissions() {
    return submissions.map((s) => ({ ...s }));
  },
  async getSubmission(id) {
    return submissions.find((s) => s.id === Number(id)) ?? null;
  },
  async decideSubmission({ id, approve, actorId }) {
    subs.decided.push({ id, approve, actorId });
    return {
      ...submissions.find((s) => s.id === Number(id)),
      status: approve ? 'approved' : 'rejected',
    };
  },
  async countPending() {
    return submissions.length;
  },
  async pendingByUrl() {
    return null;
  },
  async createSubmission() {
    return null;
  },
};
mock.module('@nichedb/db/submissions', () => subs);
const realQueue = await import('@nichedb/queue');
mock.module('@nichedb/queue', () => ({ ...realQueue, enqueueRun: async () => {} }));
const realNotify = await import('@nichedb/notify');
mock.module('@nichedb/notify', () => ({
  ...realNotify,
  sendSubmissionDecision: async () => {},
  sendSubmissionNotice: async () => {},
}));
const realQueries = await import('@nichedb/db/queries');
const queriesMock = {
  ...realQueries,
  inserted: [],
  async getCollection(slug) {
    return ['roofing-data', 'news'].includes(slug) ? { id: slug === 'news' ? 1 : 2, slug } : null;
  },
  async listCollections() {
    return [];
  },
  async getSource() {
    return null;
  },
  async insertSource(row) {
    queriesMock.inserted.push(row);
    return { id: 500 + queriesMock.inserted.length, ...row };
  },
  pgArray: () => '{}',
};
mock.module('@nichedb/db/queries', () => queriesMock);

const { registerKnowledge } = await import('./knowledge.js');
const { registerSubmit } = await import('./submit.js');
const { Denied } = await import('../lib/service.js');
const { withModules, decideModules } = await import('../lib/modules.js');

/** Where a redirect went, with its form-encoded notice made readable. */
const where = (r) => decodeURIComponent(r.headers.get('location') ?? '').replace(/\+/g, ' ');

const ADMIN = { id: 'u-admin', email: 'a@example.com', role: 'admin', timezone: 'UTC' };
const MOD = { id: 'u-mod', email: 'm@example.com', role: 'user', timezone: 'UTC', moderates: true };
const JOE = { id: 'u-joe', email: 'j@example.com', role: 'user', timezone: 'UTC' };

function appAs(user, register = registerKnowledge) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('user', user);
    await withModules(decideModules({ plan: 'free', paid: false }), next);
  });
  a.onError((err, c) => {
    if (err instanceof Denied) return c.json({ error: err.message }, err.status);
    if (err.redirect) return c.redirect(err.redirect, 303);
    throw err;
  });
  register(a);
  return a;
}

describe('applying to moderate', () => {
  test('the page names the niche, the moderators there, and asks a stranger to sign in', async () => {
    const r = await appAs(null).request('/roofing/moderate');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Moderate Roofing');
    expect(html).toContain('Sign in to apply');
    expect(html).toContain('Mo');
    expect((await appAs(null).request('/nowhere/moderate')).status).toBe(404);
  });

  test('a signed-in person applies once; a second application is refused; a member is told they are in', async () => {
    const r = await appAs(JOE).request('/roofing/moderate', {
      method: 'POST',
      body: new URLSearchParams({
        'answers.why': 'I read every roofing forum.',
        'answers.time': '3 hours',
      }),
    });
    expect(r.status).toBe(303);
    expect(where(r)).toContain('application to moderate is in');
    const claim = knowledge.claims.at(-1);
    expect(claim).toMatchObject({
      niche_id: 7,
      user_id: 'u-joe',
      role: 'moderator',
      status: 'pending',
    });
    expect(claim.answers.why).toBe('I read every roofing forum.');
    const again = await appAs(JOE).request('/roofing/moderate', {
      method: 'POST',
      body: new URLSearchParams({ 'answers.why': 'again' }),
    });
    expect(where(again)).toContain('already have an application');
    // The page now says so.
    expect(await (await appAs(JOE).request('/roofing/moderate')).text()).toContain(
      'Your application is pending',
    );
    knowledge.members['u-mod'] = { role: 'moderator', status: 'active' };
    const member = await appAs(MOD).request('/roofing/moderate', {
      method: 'POST',
      body: new URLSearchParams({}),
    });
    expect(where(member)).toContain('already moderate');
  });

  test('nobody signed in cannot post an application', async () => {
    const r = await appAs(null).request('/roofing/moderate', {
      method: 'POST',
      body: new URLSearchParams({}),
    });
    expect([303, 401]).toContain(r.status);
    expect(knowledge.claims.filter((c) => c.user_id == null)).toHaveLength(0);
  });
});

describe('a moderator and the queue', () => {
  test('sees only suggestions for the collections they moderate; an admin sees all; others are refused', async () => {
    const mine = await appAs(MOD, registerSubmit).request('/api/v1/submissions');
    expect(mine.status).toBe(200);
    expect((await mine.json()).submissions.map((s) => s.id)).toEqual([1]);
    const all = await appAs(ADMIN, registerSubmit).request('/api/v1/submissions');
    expect((await all.json()).submissions.map((s) => s.id)).toEqual([1, 2]);
    expect((await appAs(JOE, registerSubmit).request('/api/v1/submissions')).status).toBe(403);
  });

  test("decides their own collection, and only into it; somebody else's is refused", async () => {
    const reject = await appAs(MOD, registerSubmit).request('/api/v1/submissions/1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', note: 'dead feed' }),
    });
    expect(reject.status).toBe(200);
    expect(subs.decided.at(-1)).toMatchObject({ id: 1, approve: false, actorId: 'u-mod' });
    const other = await appAs(MOD, registerSubmit).request('/api/v1/submissions/2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    });
    expect(other.status).toBe(403);
    const elsewhere = await appAs(MOD, registerSubmit).request('/api/v1/submissions/1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', collection: 'news' }),
    });
    expect(elsewhere.status).toBe(403);
  });
});

describe('what a moderator may and may not do', () => {
  test('approving into their own collection works on a free plan, and the source is not theirs', async () => {
    const r = await appAs(MOD, registerSubmit).request('/api/v1/submissions/1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(r.status).toBe(200);
    const source = queriesMock.inserted.at(-1);
    expect(source.adapter).toBe('newsfeed');
    expect(source.ownerId).toBeNull();
    expect(subs.decided.at(-1)).toMatchObject({ id: 1, approve: true, actorId: 'u-mod' });
  });

  test('cannot record a contribution: a moderator is not on the ladder', async () => {
    knowledge.members['u-mod'] = { role: 'moderator', status: 'active' };
    const r = await appAs(MOD).request('/api/v1/niches/roofing/contributions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'knowledge_corrected' }),
    });
    expect(r.status).toBe(403);
  });
});
