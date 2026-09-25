import { config } from '@nichedb/config';
import { describeAdapters, describeEnrichers } from '@nichedb/core';
import { geoQueryFields, geoSchema } from '@nichedb/core/geo';
import { cleanChannelName, parseName } from '@nichedb/core/names';
import { CHILD_LEVELS, normaliseKey, normaliseZip, zipKey } from '@nichedb/core/population';
import {
  buildRows,
  checkNames,
  normaliseName,
  priceOut,
  queryTlds,
  tldOut,
} from '@nichedb/core/tlds';
import * as pop from '@nichedb/db/population';
import * as profiles from '@nichedb/db/profiles';
import * as q from '@nichedb/db/queries';
import * as tldStore from '@nichedb/db/tlds';
import { enqueueRun } from '@nichedb/queue';
import { areaOut } from '../population.js';
import { claimProfile, editProfile, profileOut, resolveRef } from '../profiles.js';
import { allowedEnrichers, collectionOut, feedOut, itemOut, sourceOut } from '../serialize.js';
import { addSource, createFeed, Denied, editSource } from '../service.js';
import { submissionOut, submitFeed } from '../submissions.js';
import { catalogueRows, namesFrom } from '../tlds.js';

/**
 * Every MCP tool, in the order they are worth learning. This array is the
 * single source of truth: tools/list is rendered from it and so is /docs/mcp.
 *
 * `run(args, ctx)` returns a JSON-serialisable value. Throw `toolError(msg)`
 * for "asked for something that is not there" -- that comes back as an
 * isError result the model can act on, not a transport failure.
 */
const toolError = (message) => Object.assign(new Error(message), { toolError: true });
const site = () => config.siteUrl;

function needUser(ctx) {
  if (!ctx.user)
    throw toolError(
      'This tool needs an API key: send Authorization: Bearer ndb_… (make one at /settings).',
    );
  return ctx.user;
}

const str = (d) => ({ type: 'string', description: d });
const int = (d) => ({ type: 'integer', description: d });
const list = (d) => ({ type: 'array', items: { type: 'string' }, description: d });

export const TOOLS = [
  {
    name: 'stats',
    description:
      'What this deployment holds: collections, sources, items, items added today, feeds.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => q.siteStats(),
  },
  {
    name: 'list_collections',
    description: 'The collections (niches) with their source, feed and item counts.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await q.listCollections()).map((c) => collectionOut(c, site())),
  },
  {
    name: 'list_adapters',
    description:
      'Every adapter this deployment can run, with the config fields each takes. Use before add_source.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => describeAdapters(),
  },
  {
    name: 'list_enrichers',
    description:
      'Every enricher (YouTube videos, Wikipedia, repo stats, downloads, company profiles, TL;DRs) and which collections turn it on by default. Items carry their results under `enrichment`.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => describeEnrichers(),
  },
  {
    name: 'list_sources',
    description: 'Sources with status, last run and item counts. Optionally one collection.',
    inputSchema: { type: 'object', properties: { collection: str('Collection slug, e.g. games') } },
    run: async ({ collection }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      return (await q.listSources({ collectionId: col?.id ?? null })).map(sourceOut);
    },
  },
  {
    name: 'list_feeds',
    description: 'Public feeds, most followed first. Optionally one collection.',
    inputSchema: { type: 'object', properties: { collection: str('Collection slug') } },
    run: async ({ collection }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      return (await q.listFeeds({ collectionId: col?.id ?? null })).map((f) => feedOut(f, site()));
    },
  },
  {
    name: 'feed_items',
    description: 'What a feed selects, newest first. Page with before_id.',
    inputSchema: {
      type: 'object',
      properties: {
        ...geoSchema,
        feed: str('Feed slug'),
        limit: int('Default 30, max 200'),
        before_id: int('Keyset cursor; cannot combine with distance sorting'),
        offset: int('Distance pagination offset'),
      },
      required: ['feed'],
    },
    run: async ({ feed, limit, before_id, offset, ...location }) => {
      const f = await q.getFeed(String(feed));
      if (!f) throw toolError(`No feed named ${feed}`);
      const items = await q.feedItems(f, {
        ...geoQueryFields(location),
        offset,
        limit: Math.min(Number(limit) || 30, 200),
        beforeId: before_id ?? null,
        timeoutMs: config.web.queryTimeoutMs,
      });
      return {
        feed: feedOut(f, site()),
        items: items.map((i) => itemOut(i, site(), { enrichers: allowedEnrichers(f) })),
      };
    },
  },
  {
    name: 'recent_items',
    description: 'Newest items, optionally narrowed to a collection, source or kind.',
    inputSchema: {
      type: 'object',
      properties: {
        ...geoSchema,
        collection: str('Collection slug'),
        source: str('Source slug'),
        kind: str('Item kind'),
        limit: int('Default 30, max 200'),
        before_id: int('Keyset cursor; cannot combine with distance sorting'),
        offset: int('Distance pagination offset'),
      },
    },
    run: async ({ collection, source, kind, limit, before_id, offset, ...location }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      const src = source ? await q.getSource(source) : null;
      if (source && !src) throw toolError(`No source named ${source}`);
      const items = await q.recentItems({
        timeoutMs: config.web.queryTimeoutMs,
        offset,
        ...geoQueryFields(location),
        collectionId: col?.id ?? null,
        sourceId: src?.id ?? null,
        kind: kind ?? null,
        limit: Math.min(Number(limit) || 30, 200),
        beforeId: before_id ?? null,
      });
      return items.map((i) => itemOut(i, site()));
    },
  },
  {
    name: 'upcoming',
    description: 'Items dated in the future (releases, launches, deadlines), soonest first.',
    inputSchema: {
      type: 'object',
      properties: {
        ...geoSchema,
        collection: str('Collection slug'),
        days: int('Horizon, default 30'),
        limit: int('Default 50'),
      },
    },
    run: async ({ collection, days, limit, ...location }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      const items = await q.upcomingItems({
        ...geoQueryFields(location),
        collectionId: col?.id ?? null,
        days: Number(days) || 30,
        limit: Math.min(Number(limit) || 50, 200),
      });
      return items.map((i) => itemOut(i, site()));
    },
  },
  {
    name: 'search_items',
    description:
      'Full-text search over titles, summaries and tags. Use this first when you know a name.',
    inputSchema: {
      type: 'object',
      properties: {
        ...geoSchema,
        q: str('Query'),
        collection: str('Collection slug'),
        kind: str('Item kind'),
        limit: int('Default 20, max 100'),
      },
      required: ['q'],
    },
    run: async ({ q: term, collection, kind, limit, ...location }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      const items = await q.searchItems(String(term), {
        ...geoQueryFields(location),
        collectionId: col?.id ?? null,
        kind: kind ?? null,
        limit: Math.min(Number(limit) || 20, 100),
      });
      return items.map((i) => itemOut(i, site()));
    },
  },
  {
    name: 'match_items',
    description:
      'Which title, channel or fixture is this name? Give a file name, a release name or a playlist entry ("Top.Gun.Maverick.2022.1080p.mkv", "US: ESPN2 HD"); it is cleaned (year, season and episode, quality tags, playlist decorations) and matched by similarity. A matchup ("NFL: Chiefs vs Bills", "Lakers @ Celtics", "Rangers at Celtic 19:45") is answered by the fixture whose two teams those are, kicking off between 36 hours ago and 7 days ahead unless date narrows it. Each result carries a score in 0..1. Use screen for films and TV, channels for television channels, sports for fixtures.',
    inputSchema: {
      type: 'object',
      properties: {
        ...geoSchema,
        q: str('The name as written'),
        collection: str('Collection slug: screen, channels or sports'),
        kind: str('Item kind: title, channel, fixture'),
        year: int('A year to prefer, when known'),
        date: str('A day (YYYY-MM-DD) to look for a fixture on, plus a day either side'),
        limit: int('Default 5, max 50'),
      },
      required: ['q'],
    },
    run: async ({ q: term, collection, kind, year, date, limit, ...location }) => {
      const col = collection ? await q.getCollection(collection) : null;
      if (collection && !col) throw toolError(`No collection named ${collection}`);
      const parsed = parseName(String(term));
      const sports = !col || col.slug === 'sports' || kind === 'fixture';
      const items = await q.matchItems(parsed.name, {
        ...geoQueryFields(location),
        collectionId: col?.id ?? null,
        kind: kind ?? null,
        year: Number(year) || parsed.year || null,
        teams: sports ? parsed.teams : null,
        league: parsed.league,
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) ? date : null,
        fallback: parsed.kind === 'fixture' ? cleanChannelName(String(term)) : null,
        limit: Math.min(Number(limit) || 5, 50),
      });
      return {
        parsed,
        items: items.map((i) => ({ ...itemOut(i, site()), score: Number(i.score) })),
      };
    },
  },
  {
    name: 'get_item',
    description: 'One item with its full adapter payload.',
    inputSchema: { type: 'object', properties: { id: int('Item id') }, required: ['id'] },
    run: async ({ id }) => {
      const item = await q.getItem(Number(id));
      if (!item) throw toolError(`No item ${id}`);
      return itemOut(item, site());
    },
  },
  {
    name: 'population',
    description:
      'Population and demography, drilled down from the world to the ZIP code. Give a `key` (us, us-ca, us-ca-los-angeles, gb, gb-england-london), a US `zip`, or a place name in `q`; no argument is the world. Answers with the area (population, year, measures: age, income, home value, rent, poverty, education, unemployment, race and Hispanic origin for the US; growth, age structure, births, deaths, fertility, life expectancy, migration, GDP per head and Gini for countries), how many areas of each level it contains, and the largest of its children at `level` (country, state, city or zip). Sources: World Bank, US Census ACS 5-year, GeoNames.',
    inputSchema: {
      type: 'object',
      properties: {
        key: str('Area key, e.g. us, us-ca, us-ca-los-angeles, us-90210, de (optional)'),
        zip: str('A US ZIP code (optional)'),
        q: str('A place name to look up, e.g. Springfield (optional)'),
        level: str('Which children to list: country, state, city or zip (optional)'),
        limit: int('Children to list, default 20, max 500'),
        offset: int('Skip this many children, for paging'),
      },
    },
    run: async ({ key, zip, q: term, level, limit, offset }) => {
      const n = Math.min(Math.max(1, Number(limit) || 20), 500);
      const skip = Math.max(0, Number(offset) || 0);
      if (term && !zip && !key) {
        const z = normaliseZip(term);
        if (!z) return { q: term, areas: (await pop.areasNamed(term, { limit: n })).map(areaOut) };
        zip = z;
      }
      const areaKey = zip
        ? normaliseZip(zip)
          ? zipKey(normaliseZip(zip))
          : null
        : key
          ? normaliseKey(key)
          : null;
      if ((zip || key) && !areaKey) throw toolError('That is not an area key or a ZIP code.');
      if (!areaKey) {
        const [levels, list] = await Promise.all([
          pop.populationStats(),
          pop.areasIn({ level: 'country', limit: n, offset: skip }),
        ]);
        return { levels, total: list.total, countries: list.areas.map(areaOut) };
      }
      const row = await pop.areaByKey(areaKey);
      if (!row) throw toolError(`No area ${areaKey}. Try q with its name.`);
      const counts = await pop.childCounts(areaKey);
      const offered = (CHILD_LEVELS[row.data?.level] ?? []).filter((l) => counts[l] > 0);
      const child = offered.includes(level) ? level : offered[0];
      const list = child
        ? await pop.areasIn({ within: areaKey, level: child, limit: n, offset: skip })
        : null;
      return {
        area: areaOut(row),
        contains: counts,
        children: child
          ? { level: child, total: list.total, areas: list.areas.map(areaOut) }
          : null,
      };
    },
  },
  {
    name: 'create_feed',
    description:
      'Save a query as a feed (needs a key). Sources, kinds and tags narrow; q is a text match; upcoming keeps only future-dated items.',
    inputSchema: {
      type: 'object',
      properties: {
        ...geoSchema,
        collection: str('Collection slug'),
        name: str('Feed name'),
        description: str('Optional'),
        sources: list('Source slugs'),
        kinds: list('Item kinds'),
        tags: list('Tags, any match'),
        q: str('Text match'),
        upcoming: { type: 'boolean' },
        enrichers: list('Enrichers to show; omit for the collection defaults'),
        public: { type: 'boolean', description: 'Default true' },
      },
      required: ['collection', 'name'],
    },
    run: async (args, ctx) => {
      const user = needUser(ctx);
      const feed = await createFeed(user, {
        collection: args.collection,
        name: args.name,
        description: args.description,
        query: {
          ...geoQueryFields(args),
          sources: args.sources,
          kinds: args.kinds,
          tags: args.tags,
          q: args.q,
          upcoming: args.upcoming,
          enrichers: args.enrichers,
        },
        isPublic: args.public,
      });
      return feedOut(await q.getFeed(feed.slug), site());
    },
  },
  {
    name: 'follow_feed',
    description: 'Follow a feed as the key owner (needs a key). Channels: webpush, email, webhook.',
    inputSchema: {
      type: 'object',
      properties: {
        feed: str('Feed slug'),
        channels: list('Default webpush,email'),
        webhook_url: str('For the webhook channel'),
        webhook_secret: str('Shared secret the receiver verifies with'),
      },
      required: ['feed'],
    },
    run: async ({ feed, channels, webhook_url, webhook_secret }, ctx) => {
      const user = needUser(ctx);
      const f = await q.getFeed(String(feed));
      if (!f) throw toolError(`No feed named ${feed}`);
      await q.followFeed({
        userId: user.id,
        feedId: f.id,
        channels,
        webhookUrl: webhook_url ?? null,
        webhookSecret: webhook_secret ?? null,
      });
      return { ok: true, feed: feedOut(await q.getFeed(f.slug), site()) };
    },
  },
  {
    name: 'submit_feed',
    description:
      'Suggest an RSS or Atom feed for the index. No key needed. An admin reviews every suggestion before anything is fetched; approved podcast feeds are handed to rssamplifier, everything else becomes a source here.',
    inputSchema: {
      type: 'object',
      properties: {
        url: str('The feed URL, starting with https://'),
        collection: str('Collection slug it belongs in (optional; an admin decides otherwise)'),
        note: str('Why it belongs here: who publishes it, what it covers (optional)'),
        email: str('Where to hear back, if you are not sending a key (optional)'),
      },
      required: ['url'],
    },
    run: async (args, ctx) => {
      const { submission, duplicate } = await submitFeed({
        user: ctx.user ?? null,
        url: args.url,
        collection: args.collection ?? null,
        note: args.note ?? null,
        email: args.email ?? null,
      });
      return {
        ok: true,
        duplicate,
        submission: submissionOut(submission),
        note: duplicate
          ? 'That feed was already suggested and is waiting for review.'
          : 'Suggested. An admin will review it; approved feeds appear on their collection page.',
      };
    },
  },
  {
    name: 'search_profiles',
    description:
      'People: one entry per person assembled from every app that serves their OpenProfile.md (podcasters from p0dcasters, public profiles from OutreachGraph). Search by name, headline or anything in the document; newest change first. Each answer carries the page, the openprofile.md URL, accounts, topics, Broadcast shows and the Guest section.',
    inputSchema: {
      type: 'object',
      properties: {
        q: str('Text to match against the name, headline and document (optional)'),
        since: str('ISO time: only profiles changed after it (optional)'),
        limit: int('Default 30, max 200'),
      },
    },
    run: async ({ q: term, since, limit }) =>
      (
        await profiles.listProfiles({
          q: term ?? null,
          since: since ?? null,
          limit: Math.min(Number(limit) || 30, 200),
        })
      ).map(profileOut),
  },
  {
    name: 'get_profile',
    description:
      'One person by id, `<slug>-<id>` or handle: the parsed view and the OpenProfile.md as served.',
    inputSchema: {
      type: 'object',
      properties: { ref: str('Profile id, slug-id or handle') },
      required: ['ref'],
    },
    run: async ({ ref }) => {
      const { profile } = await resolveRef(String(ref));
      if (!profile?.public) throw toolError(`No profile ${ref}`);
      return { profile: profileOut(profile), markdown: profile.doc };
    },
  },
  {
    name: 'claim_profile',
    description:
      'Claim a profile as the key owner (needs a key). Proven when the key owner’s email is one the profile lists, or when the person’s site or show page links back to the profile’s nichedb page. An admin may claim on behalf of an email.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: str('Profile id, slug-id or handle'),
        email: str('Admins only: claim it for this email'),
      },
      required: ['ref'],
    },
    run: async ({ ref, email }, ctx) => {
      const user = needUser(ctx);
      const { profile } = await resolveRef(String(ref));
      if (!profile) throw toolError(`No profile ${ref}`);
      const out = await claimProfile(user, profile, { email: email ?? null });
      return { ...out, profile: profileOut(await profiles.getProfile(profile.id)) };
    },
  },
  {
    name: 'update_profile',
    description:
      'Edit a profile you own (needs a key). Send `markdown`, a whole OpenProfile.md that replaces what you wrote before, or any of `name`, `headline`, `identity` (key: value, null removes), `sections` (name: body, `none` removes), `handle`, `public`. What you write wins over every source and survives every re-read.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: str('Profile id, slug-id or handle'),
        markdown: str('A complete OpenProfile.md'),
        name: str('The name'),
        headline: str('One line'),
        identity: {
          type: 'object',
          description: 'Identity keys: Kind, Web, Email, Location, ...; null removes',
        },
        sections: {
          type: 'object',
          description:
            'Section bodies by name (accounts, topics, broadcast, guest, ...); the word none removes one',
        },
        handle: str('Your URL: /c/profiles/<handle>'),
        public: { type: 'boolean', description: 'Listed and pulled by other directories' },
      },
      required: ['ref'],
    },
    run: async (args, ctx) => {
      const user = needUser(ctx);
      const { profile } = await resolveRef(String(args.ref));
      if (!profile) throw toolError(`No profile ${args.ref}`);
      const updated = await editProfile(user, profile, {
        markdown: typeof args.markdown === 'string' ? args.markdown : undefined,
        patch: {
          name: args.name,
          headline: args.headline,
          identity: args.identity,
          sections: args.sections,
        },
        handle: args.handle,
        isPublic: args.public,
      });
      return { profile: profileOut(updated), markdown: updated.doc };
    },
  },
  {
    name: 'add_source',
    description:
      'Add a source: an adapter with a config, fetched on a schedule (needs a key; admins and Pro). Call list_adapters first for the fields.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: str('Adapter name, e.g. github-releases'),
        collection: str("Collection slug; defaults to the adapter's"),
        name: str('Display name'),
        config: { type: 'object', description: 'Adapter config fields' },
        cadence_minutes: int('5 to 1440'),
      },
      required: ['adapter'],
    },
    run: async (args, ctx) => {
      const user = needUser(ctx);
      const s = await addSource(user, {
        adapter: args.adapter,
        collection: args.collection,
        name: args.name,
        config: args.config ?? {},
        cadenceMinutes: args.cadence_minutes,
      });
      await enqueueRun(s.id).catch(() => {});
      return sourceOut(await q.getSource(s.slug));
    },
  },
  {
    name: 'run_source',
    description:
      'Fetch a source now instead of waiting for its schedule (needs a key; owner or admin).',
    inputSchema: {
      type: 'object',
      properties: { source: str('Source slug') },
      required: ['source'],
    },
    run: async ({ source }, ctx) => {
      const user = needUser(ctx);
      const s = await q.getSource(String(source));
      if (!s) throw toolError(`No source named ${source}`);
      await editSource(user, s, {}); // permission check
      await q.requestRun(s.id);
      await enqueueRun(s.id, { force: true }).catch(() => {});
      return { ok: true, source: s.slug };
    },
  },
  {
    name: 'search_tlds',
    description:
      "Top-level domains: every label in IANA's root, with type, registry, RDAP server and each registrar's one-year register/renew/transfer price (Porkbun, Dynadot, Cloudflare, OVHcloud). Sorted by renewal by default, because the first year is a promotion. `best` is the cheapest USD price across registrars; with `registrar` it is that registrar's own price in its currency. Answers carry facet counts. `trap: true` keeps only labels that renew at 2x the first year or more.",
    inputSchema: {
      type: 'object',
      properties: {
        q: str('Text in the label, its Unicode form or the registry name (optional)'),
        type: str(
          'generic, country-code, sponsored, generic-restricted, infrastructure, test; comma separated (optional)',
        ),
        manager: str('Exact registry name, as IANA writes it (optional)'),
        registrar: str(
          'porkbun, dynadot, cloudflare, ovh (optional): only labels it sells, at its prices',
        ),
        max_renew: { type: 'number', description: 'Highest renewal price (optional)' },
        max_register: { type: 'number', description: 'Highest first-year price (optional)' },
        trap: { type: 'boolean', description: 'Only labels renewing at 2x the first year or more' },
        idn: {
          type: 'boolean',
          description: 'true: internationalised labels only; false: ASCII only',
        },
        status: str('delegated (default), removed, or all'),
        sort: str(
          'renew (default), register, transfer, restore, ratio, tld, registrars, type, manager, first_seen',
        ),
        order: str('asc or desc'),
        limit: int('Default 50, max 500'),
        offset: int('Default 0'),
      },
    },
    run: async (args = {}) => {
      const result = queryTlds(await catalogueRows(), {
        ...args,
        limit: Math.min(Number(args.limit) || 50, 500),
      });
      return {
        total: result.total,
        facets: result.facets,
        tlds: result.rows.map((r) => tldOut(r, site())),
      };
    },
  },
  {
    name: 'get_tld',
    description:
      'One top-level domain: type, registry, RDAP server, when it entered or left the root, every registrar price (register, renew, transfer, restore, promotions, privacy, restrictions) and its change history.',
    inputSchema: {
      type: 'object',
      properties: { tld: str('The label, with or without the dot; Unicode or xn-- both work') },
      required: ['tld'],
    },
    run: async ({ tld }) => {
      const raw = String(tld ?? '')
        .toLowerCase()
        .replace(/^\./, '');
      const ascii = normaliseName(`x.${raw}`)?.slice(2) ?? raw;
      const row = await tldStore.getTld(ascii);
      if (!row) throw toolError(`.${raw} is not in IANA's list`);
      const [built] = buildRows({ tlds: [row], prices: row.prices.filter((p) => !p.gone_at) });
      return {
        ...tldOut(built, site()),
        no_longer_sold_at: row.prices.filter((p) => p.gone_at).map(priceOut),
        changes: row.changes,
      };
    },
  },
  {
    name: 'tld_changes',
    description:
      "Top-level domains added to or removed from IANA's root, newest first, with the IANA list version each happened in. Nobody else publishes this diff.",
    inputSchema: {
      type: 'object',
      properties: {
        since: str('ISO time: only changes after it (optional)'),
        change: str('added, removed or returned (optional)'),
        limit: int('Default 100, max 1000'),
      },
    },
    run: async ({ since, change, limit }) =>
      tldStore.listChanges({
        since: since ?? null,
        change: ['added', 'removed', 'returned'].includes(change) ? change : null,
        limit: limit ?? 100,
      }),
  },
  {
    name: 'check_domain',
    description:
      'Is a domain name registered? Asks each registry over RDAP. Give `name` as a full name (foo.watches), or a bare word with `tlds` (foo + com,dev,io), or several names comma separated. Each answer is registered (with registrar and expiry), not_registered, or unknown. not_registered means the registry holds no registration; the name may still be reserved or premium, so it is not a promise that it is for sale. unknown (no RDAP server, a timeout, a 429) is never a yes. Each answer carries the cheapest known USD price for its ending.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('foo.watches, or foo, or a.com,b.dev'),
        tlds: str('Endings to try a bare word under, comma separated (optional)'),
      },
      required: ['name'],
    },
    run: async ({ name, tlds }) => {
      const { names, truncated } = namesFrom({ name, tlds });
      if (!names.length) throw toolError('name is required');
      const rows = await catalogueRows();
      const byTld = new Map(rows.map((r) => [r.tld, r]));
      const results = await checkNames(names, {
        rdapFor: async (t) => byTld.get(t)?.rdap ?? null,
        userAgent: `niche-db/0.1 (+${site()})`,
      });
      return {
        truncated,
        results: results.map((r) => ({ ...r, cheapest: byTld.get(r.tld)?.best ?? null })),
      };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const describe = (t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
});

/** Turn a Denied into a tool error so the model sees why. */
export async function runTool(tool, args, ctx) {
  try {
    return await tool.run(args ?? {}, ctx);
  } catch (err) {
    if (err instanceof Denied) throw toolError(err.message);
    throw err;
  }
}
