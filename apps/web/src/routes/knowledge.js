import { config } from '@nichedb/config';
import * as k from '@nichedb/db/knowledge';
import {
  CONTRIBUTION_EVENT_TYPES,
  isKnownEventType,
  isReservedNicheSlug,
} from '@nichedb/knowledge';
import { cached, render, requireUser, respond } from '../lib/http.js';
import { Denied, isAdmin } from '../lib/service.js';
import {
  InfluencerDashboard,
  InfluencerPage,
  KnowledgeAdmin,
  NichePage,
  OpportunitiesPage,
  OpportunityPage,
} from '../views/knowledge.jsx';

/**
 * Knowledge Influencers: the people who know an industry supervising the
 * agents that build for it, and the ladder that pays them 20% to 80% of what
 * the niche makes.
 *
 * The niche page is served from the site root, which is what the PRD asks for
 * and what a person searching their own industry expects to find. That route
 * is registered last and a niche may not take a slug the site already uses
 * (`isReservedNicheSlug`, enforced when the niche is created), so it can never
 * shadow a real page however the router resolves ties.
 */

const requireAdmin = (c) => {
  const user = requireUser(c);
  if (!isAdmin(user)) throw new Denied('Admins only.', 403);
  return user;
};

/** Pull `answers.<key>` fields out of a posted form, trimmed and capped. */
function answersFromForm(body) {
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('answers.')) continue;
    const text = String(Array.isArray(value) ? value[0] : value)
      .trim()
      .slice(0, 2000);
    if (text) out[key.slice(8)] = text;
  }
  return out;
}

export function registerKnowledge(app) {
  /* --------------------------------------------------------- public pages -- */

  app.get('/opportunities', async (c) =>
    cached(c, 'opportunities', async () => {
      const [opportunities, tiers] = await Promise.all([k.listOpportunities(), k.listTiers()]);
      return render(
        <OpportunitiesPage user={c.get('user')} opportunities={opportunities} tiers={tiers} />,
      );
    }),
  );

  app.get('/opportunities/:slug', async (c) => {
    const opportunity = await k.getOpportunity(c.req.param('slug'));
    if (!opportunity) return c.notFound();
    const user = c.get('user');
    const [tiers, claims] = await Promise.all([
      k.listTiers(),
      user ? k.listClaims({ status: null, userId: user.id, limit: 20 }) : [],
    ]);
    return c.html(
      await render(
        <OpportunityPage
          user={user}
          opportunity={opportunity}
          tiers={tiers}
          claim={claims.find((x) => x.niche_id === opportunity.niche_id) ?? null}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  /**
   * Apply to operate a niche. Nothing about the application grants a share:
   * an approved claim starts at 20% like everybody else, and the answers are
   * stored as data for a human to read.
   */
  app.post('/opportunities/:slug/claim', async (c) => {
    const user = requireUser(c);
    const opportunity = await k.getOpportunity(c.req.param('slug'));
    if (!opportunity) return c.notFound();

    const existing = await k.memberOf({ nicheId: opportunity.niche_id, userId: user.id });
    if (existing?.status === 'active')
      return respond(c, {
        redirectTo: `/opportunities/${opportunity.slug}`,
        error: 'You already operate this niche.',
      });

    const claim = await k.createClaim({
      nicheId: opportunity.niche_id,
      userId: user.id,
      answers: answersFromForm(await c.req.parseBody()),
    });
    return respond(c, {
      json: { claim },
      redirectTo: `/opportunities/${opportunity.slug}`,
      notice: claim
        ? 'Your application is in. We will be in touch.'
        : 'You have already applied for this niche.',
    });
  });

  /* ------------------------------------------------------------ dashboard -- */

  app.get('/dashboard', (c) => c.redirect('/dashboard/niches', 303));

  app.get('/dashboard/niches', async (c) => {
    const user = requireUser(c);
    const [niches, contributions, tiers] = await Promise.all([
      k.nichesForUser(user.id),
      k.listContributions({ influencerId: user.id, limit: 50 }),
      k.listTiers(),
    ]);
    return c.html(
      await render(
        <InfluencerDashboard
          user={user}
          niches={niches}
          contributions={contributions}
          tiers={tiers}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  /* ---------------------------------------------------------------- admin -- */

  app.get('/admin/knowledge', async (c) => {
    const user = requireAdmin(c);
    const [claims, pending, audit] = await Promise.all([
      k.listClaims({ status: 'pending' }),
      k.listContributions({ status: 'pending', limit: 100 }),
      k.listAudit({ limit: 50 }),
    ]);
    return c.html(
      await render(
        <KnowledgeAdmin
          user={user}
          claims={claims}
          pending={pending}
          audit={audit}
          notice={c.req.query('notice')}
          error={c.req.query('error')}
        />,
      ),
    );
  });

  app.post('/admin/knowledge/claims/:id', async (c) => {
    const user = requireAdmin(c);
    const body = await c.req.parseBody();
    const decided = await k.decideClaim({
      claimId: c.req.param('id'),
      approve: body.decision === 'approve',
      actorId: user.id,
      note: body.note ? String(body.note).slice(0, 500) : null,
    });
    return respond(c, {
      json: { claim: decided },
      redirectTo: '/admin/knowledge',
      notice: decided ? `Claim ${decided.status}.` : null,
      error: decided ? null : 'That claim was already decided.',
    });
  });

  app.post('/admin/knowledge/contributions/:id', async (c) => {
    const user = requireAdmin(c);
    const body = await c.req.parseBody();
    const decision = String(body.decision ?? '');

    if (decision === 'reverse') {
      const out = await k.reverseContribution({
        id: c.req.param('id'),
        actorId: user.id,
        reason: body.reason ? String(body.reason).slice(0, 500) : 'reversed by an admin',
      });
      return respond(c, {
        json: out,
        redirectTo: '/admin/knowledge',
        notice: out ? 'Reversed.' : null,
        error: out ? null : 'Only a verified contribution can be reversed.',
      });
    }

    const out = await k.verifyContribution({
      id: c.req.param('id'),
      actorId: user.id,
      approve: decision === 'verify',
      note: body.note ? String(body.note).slice(0, 500) : null,
    });
    return respond(c, {
      json: out,
      redirectTo: '/admin/knowledge',
      notice: out ? (out.changed ? `Done. Tier is now ${out.tier.name}.` : 'Done.') : null,
      error: out ? null : 'That contribution was already decided.',
    });
  });

  /* -------------------------------------------------------------- the API -- */

  app.get('/api/v1/niches', async (c) => c.json({ niches: await k.listNiches() }));

  app.get('/api/v1/niches/:slug', async (c) => {
    const niche = await k.getNiche(c.req.param('slug'));
    if (!niche) return c.json({ error: 'not found' }, 404);
    return c.json({ niche, members: await k.nicheMembers(niche.id) });
  });

  app.get('/api/v1/opportunities', async (c) =>
    c.json({ opportunities: await k.listOpportunities(), tiers: await k.listTiers() }),
  );

  app.get('/api/v1/opportunities/:slug', async (c) => {
    const opportunity = await k.getOpportunity(c.req.param('slug'));
    if (!opportunity) return c.json({ error: 'not found' }, 404);
    return c.json({ opportunity });
  });

  app.get('/api/v1/influencers/:handle', async (c) => {
    const influencer = await k.influencerByHandle(c.req.param('handle'));
    if (!influencer) return c.json({ error: 'not found' }, 404);
    // A profile is public; what it earns is not. Only the tier travels.
    return c.json({
      influencer: {
        handle: influencer.handle,
        displayName: influencer.display_name,
        joinedAt: influencer.created_at,
        totals: influencer.totals,
        niches: influencer.niches.map((n) => ({
          slug: n.slug,
          name: n.name,
          role: n.role,
          tier: n.tier_slug,
          shareBps: Number(n.share_bps),
          verifiedContributions: Number(n.verified_count),
        })),
      },
    });
  });

  app.get('/api/v1/me/niches', async (c) =>
    c.json({ niches: await k.nichesForUser(requireUser(c).id) }),
  );

  app.get('/api/v1/me/contributions', async (c) =>
    c.json({
      contributions: await k.listContributions({
        influencerId: requireUser(c).id,
        limit: Number(c.req.query('limit')) || 100,
      }),
    }),
  );

  app.get('/api/v1/claims/:id', async (c) => {
    const user = requireUser(c);
    const claim = await k.getClaim(c.req.param('id'));
    if (!claim) return c.json({ error: 'not found' }, 404);
    // Somebody else's application is not public: it is their answers about
    // their own business.
    if (claim.user_id !== user.id && !isAdmin(user)) return c.json({ error: 'not found' }, 404);
    return c.json({ claim });
  });

  /**
   * Record a contribution.
   *
   * Only a member of the niche may. What it is worth is the engine's
   * decision, never the caller's: `points` is a request that a ranged type
   * clamps, and everything else ignores it.
   */
  app.post('/api/v1/niches/:slug/contributions', async (c) => {
    const user = requireUser(c);
    const niche = await k.getNiche(c.req.param('slug'));
    if (!niche) return c.json({ error: 'not found' }, 404);

    const member = await k.memberOf({ nicheId: niche.id, userId: user.id });
    if (member?.status !== 'active')
      return c.json({ error: 'You do not operate this niche.' }, 403);

    const body = await c.req.json().catch(() => ({}));
    if (!isKnownEventType(body.type))
      return c.json({ error: 'unknown type', known: CONTRIBUTION_EVENT_TYPES }, 400);
    // An admin's thumb on the scale is not something an API caller may reach for.
    if (body.type === 'manual_adjustment' && !isAdmin(user))
      return c.json({ error: 'admins only' }, 403);

    const out = await k.recordContribution({
      nicheId: niche.id,
      influencerId: user.id,
      type: body.type,
      points: body.points,
      evidence: body.evidence ?? {},
      sourceType: body.sourceType ?? null,
      sourceId: body.sourceId ?? null,
    });
    return c.json(
      {
        recorded: Boolean(out.event),
        duplicate: Boolean(out.duplicate),
        points: out.points,
        status: out.status,
        reason: out.reason,
      },
      out.event ? 201 : 200,
    );
  });

  /* --------------------------------------------- machine-readable a niche -- */

  /**
   * What an agent needs to know to use a niche: what it is, who stands behind
   * it, what is readable and what it costs. No secrets, and nothing here is
   * an instruction to whatever reads it.
   */
  app.get('/:slug/manifest.json', async (c) => {
    const niche = await k.getNiche(c.req.param('slug'));
    if (!niche) return c.notFound();
    const members = await k.nicheMembers(niche.id);
    return c.json({
      name: niche.name,
      slug: niche.slug,
      homepage: `${config.siteUrl}/${niche.slug}`,
      description: niche.description,
      operators: members.map((m) => ({
        handle: m.handle,
        name: m.display_name,
        tier: m.tier_slug,
        profile: m.handle ? `${config.siteUrl}/@${m.handle}` : null,
      })),
      feeds: niche.collection_slug ? [`${config.siteUrl}/f/${niche.collection_slug}.rss`] : [],
      apis: [`${config.siteUrl}/api/v1/niches/${niche.slug}`],
      datasets: niche.collection_slug ? [`${config.siteUrl}/c/${niche.collection_slug}`] : [],
      skills: [`${config.siteUrl}/${niche.slug}/skill.md`],
      commercialMachineAccess: true,
      // The gateway's own terms, read from the same configuration it prices
      // against, so this document cannot drift from what a crawler is charged.
      x402: {
        enabled: true,
        priceCentsPerDay: config.x402.priceCents,
        buyAt: `${config.siteUrl}/crawl`,
      },
    });
  });

  app.get('/:slug/skill.md', async (c) => {
    const niche = await k.getNiche(c.req.param('slug'));
    if (!niche) return c.notFound();
    const members = await k.nicheMembers(niche.id);
    const operators = members.length
      ? members.map((m) => `- ${m.display_name ?? m.handle} (${m.tier_slug})`).join('\n')
      : '- Not yet operated by a Knowledge Influencer.';
    c.header('content-type', 'text/markdown; charset=utf-8');
    return c.body(
      [
        `# ${niche.name}`,
        '',
        niche.description ?? `A niche on ${config.siteName}.`,
        '',
        '## Who stands behind this',
        '',
        operators,
        '',
        '## Reading it',
        '',
        `- Page: ${config.siteUrl}/${niche.slug}`,
        `- API: ${config.siteUrl}/api/v1/niches/${niche.slug}`,
        niche.collection_slug ? `- Feed: ${config.siteUrl}/f/${niche.collection_slug}.rss` : null,
        `- Manifest: ${config.siteUrl}/${niche.slug}/manifest.json`,
        '',
        '## Paying for it',
        '',
        `Training crawlers are charged by the day and buy a pass at ${config.siteUrl}/crawl.`,
        'People, search engines and retrieval crawlers pass through untouched.',
        '',
        '## Provenance',
        '',
        'Records here carry the source they came from. Anything a human operator',
        'contributed is marked as such and was verified before it counted.',
        '',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
  });

  /**
   * The niche page itself, at the site root.
   *
   * Registered last so every real route is matched first, and reserved slugs
   * are refused when a niche is created, so this can only ever answer for a
   * name nothing else owns.
   */
  app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');

    // `/@sarah` is a person, not a niche. It is answered here rather than by a
    // route of its own because Hono does not match a param behind a literal
    // prefix inside a segment: `/@:handle` never fires, and the request lands
    // on this handler with the `@` still on the front.
    if (slug.startsWith('@')) {
      const influencer = await k.influencerByHandle(slug.slice(1));
      if (!influencer) return c.notFound();
      return c.html(await render(<InfluencerPage user={c.get('user')} influencer={influencer} />));
    }

    if (isReservedNicheSlug(slug)) return c.notFound();
    const niche = await k.getNiche(slug);
    if (!niche || niche.status === 'draft' || niche.status === 'archived') return c.notFound();
    return cached(c, `niche:${niche.slug}`, async () => {
      const [members, tiers, contributions] = await Promise.all([
        k.nicheMembers(niche.id),
        k.listTiers(),
        k.listContributions({ nicheId: niche.id, status: 'verified', limit: 15 }),
      ]);
      return render(
        <NichePage
          user={c.get('user')}
          niche={niche}
          members={members}
          tiers={tiers}
          contributions={contributions}
        />,
      );
    });
  });
}
