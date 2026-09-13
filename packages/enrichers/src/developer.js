import { readFileSync } from 'node:fs';
import { SEED_DOMAINS } from './developer-seed.js';
import { defineEnricher } from './enricher.js';

/**
 * How a developer gets at a hosting provider: the official CLI and the
 * command that installs it, the API docs, the Terraform provider, the status
 * page, the GitHub org.
 *
 * Reading forty install guides to find out which host has a CLI is exactly
 * the chore a directory should do once for everyone, so this does it in
 * three steps and says which step answered:
 *
 * 1. The seed (developer-seed.js): commands read verbatim off the vendor's
 *    own guide, re-verified by scripts/verify-developer-seed.js. `verified:
 *    "guide"`.
 * 2. The registries, for a host the seed does not know: Homebrew's formula
 *    index, npm search and the Terraform registry, each matched on the
 *    provider's registrable DOMAIN (the formula's homepage, the package's
 *    homepage, the Terraform namespace's source) and never on its name,
 *    because "Digital" must not find DigitalOcean and a wrong CLI is worse
 *    than none. `verified: "registry"`, with the install line the registry
 *    itself implies (brew install <formula>, npm i -g <package>).
 * 3. The conventional URLs a host publishes: status.<domain>, a Statuspage
 *    /api/v2/status.json, developers.<domain>, <domain>/docs/api.
 *
 * Nothing is guessed. A host with no CLI gets `cli: null` and the date we
 * looked; that is a fact a reader can use too.
 */

const BREW_INDEX = 'https://formulae.brew.sh/api/formula.json';
const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search';
const TF_PROVIDERS = 'https://registry.terraform.io/v2/providers';
let brewCache = { at: 0, byDomain: new Map() };

/** eTLD+1 by the rule of thumb the storefront adapter uses (kept in step by hand). */
export function registrableDomain(hostname) {
  const labels = String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '')
    .split('.');
  if (labels.length <= 2) return labels.join('.');
  const [tld, sld] = [labels.at(-1), labels.at(-2)];
  const publicSld = /^(co|com|net|org|ac|gov|edu|or|ne|go|in)$/.test(sld) && tld.length === 2;
  return labels.slice(publicSld ? -3 : -2).join('.');
}

const domainOf = (url) => {
  try {
    return registrableDomain(new URL(String(url)).hostname.replace(/^www\./, ''));
  } catch {
    return null;
  }
};

const fixture = (name) => {
  try {
    return JSON.parse(
      readFileSync(new URL(`../../adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
    );
  } catch {
    return null;
  }
};
/** FindHost id -> home URL, from the storefront survey's corpus. */
export const FINDHOST_HOMES = fixture('findhost-homes.json') ?? {};

/** The provider's own web origin for a hosting row, or null when nothing names one. */
export function homeOf(item, homes = FINDHOST_HOMES) {
  const d = item.data ?? {};
  const cands = [d.web, d.home, d.homepage, homes[d.findhostId ?? d.provider ?? '']];
  if (item.url && !/findhost\.app/.test(item.url)) cands.push(item.url);
  for (const c of cands) {
    if (!c) continue;
    try {
      return new URL(String(c)).origin;
    } catch {}
  }
  return null;
}

/**
 * A provider that serves an OpenServer 0.2 descriptor states its own
 * developer block (the openserver adapter keeps it at data.developer). The
 * provider's words win over the seed and the registries: `"cli": null` there
 * means it has none, so nothing is searched; a missing key means unknown.
 */
export function descriptorBlock(item) {
  const d = item?.data?.developer;
  if (!d || typeof d !== 'object') return null;
  const cli =
    d.cli && typeof d.cli === 'object'
      ? {
          name: d.cli.name ?? null,
          repo: d.cli.repo ?? null,
          docs: d.cli.docs ?? null,
          install: d.cli.install && typeof d.cli.install === 'object' ? { ...d.cli.install } : {},
          verified: 'descriptor',
        }
      : null;
  return {
    cli,
    api_docs: d.api_docs ?? null,
    terraform: d.terraform ?? null,
    status: d.status ?? null,
    github: d.github ?? null,
    source_notes: [
      "from the provider's own OpenServer descriptor",
      d.cli === null ? 'cli: the provider states it has none' : null,
    ].filter(Boolean),
    cliStated: 'cli' in d,
  };
}

/** The seed's answer for a domain, shaped as the stored block, or null. */
export function seedBlock(domain) {
  const row = SEED_DOMAINS.get(domain);
  if (!row) return null;
  const cli = row.cli
    ? {
        name: row.cli.name,
        repo: row.cli.repo ?? null,
        docs: row.cli.docs,
        install: { ...row.cli.install },
        verified: 'guide',
        ...(row.cli.deprecated ? { deprecated: true } : {}),
        ...(row.cli.note ? { note: row.cli.note } : {}),
      }
    : null;
  return {
    cli,
    api_docs: row.apiDocs ?? null,
    terraform: row.terraform
      ? {
          source: row.terraform,
          docs: `https://registry.terraform.io/providers/${row.terraform}/latest/docs`,
        }
      : null,
    status: null,
    github: cli?.repo ? (cli.repo.match(/https:\/\/github\.com\/[^/]+/)?.[0] ?? null) : null,
    source_notes: [
      cli
        ? `cli: read off ${row.cli.docs}`
        : `cli: none found on ${row.checked ?? 'the date the seed was written'}${row.note ? ` (${row.note})` : ''}`,
      row.terraform ? 'terraform: seed' : null,
    ].filter(Boolean),
  };
}

/** Homebrew formulae whose homepage is on this domain and that look like a CLI. */
export function brewMatches(formulae, domain) {
  return (formulae ?? []).filter((f) => {
    if (domainOf(f.homepage) !== domain) return false;
    const blob = `${f.name} ${f.desc ?? ''}`.toLowerCase();
    return /\bcli\b|command[- ]line|terminal/.test(blob) || /cli$|ctl$/.test(f.name);
  });
}

/** npm packages from a search whose homepage is on this domain and that look like a CLI. */
export function npmMatches(objects, domain) {
  return (objects ?? [])
    .map((o) => o.package ?? o)
    .filter((p) => {
      const home = p.links?.homepage ?? p.homepage;
      if (domainOf(home) !== domain) return false;
      const blob = `${p.name} ${p.description ?? ''} ${(p.keywords ?? []).join(' ')}`.toLowerCase();
      return /\bcli\b|command[- ]line/.test(blob);
    });
}

/**
 * Terraform providers whose name is the provider's slug and whose namespace
 * is the vendor itself (or hashicorp, which publishes the big clouds').
 * The registry's own `source` URL must sit on GitHub under that namespace.
 */
export function terraformMatches(data, slug) {
  return (data ?? [])
    .map((d) => d.attributes ?? d)
    .filter((a) => {
      const ns = String(a.namespace ?? '').toLowerCase();
      const name = String(a.name ?? '').toLowerCase();
      if (name !== slug) return false;
      return ns === slug || ns === 'hashicorp' || ['official', 'partner'].includes(a.tier);
    });
}

async function brewIndex(http) {
  if (Date.now() - brewCache.at < 6 * 60 * 60 * 1000 && brewCache.byDomain.size)
    return brewCache.byDomain;
  const rows = await http.json(BREW_INDEX, { timeoutMs: 60_000 });
  const byDomain = new Map();
  for (const f of rows ?? []) {
    const d = domainOf(f.homepage);
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push({ name: f.name, desc: f.desc, homepage: f.homepage });
  }
  brewCache = { at: Date.now(), byDomain };
  return byDomain;
}

async function probe(http, url) {
  try {
    const res = await http.request(url, { method: 'GET', timeoutMs: 10_000 });
    if (res.status !== 200) return null;
    // A soft 404 that bounced to the home page is not a docs page.
    const final = new URL(res.url || url);
    if (final.pathname === '/' && new URL(url).pathname !== '/') return null;
    return res.url || url;
  } catch {
    return null;
  }
}

/** The pages a host conventionally publishes, tried in the order they are usually found. */
export async function conventionalLinks(http, origin) {
  const host = new URL(origin).hostname.replace(/^www\./, '');
  const domain = registrableDomain(host);
  const status =
    (await probe(http, `https://status.${domain}/api/v2/status.json`)) ??
    (await probe(http, `https://status.${domain}/`)) ??
    (await probe(http, `${origin}/status`));
  const api =
    (await probe(http, `https://developers.${domain}/`)) ??
    (await probe(http, `https://developer.${domain}/`)) ??
    (await probe(http, `${origin}/docs/api`)) ??
    (await probe(http, `https://api.${domain}/docs`)) ??
    (await probe(http, `${origin}/api-docs`));
  return {
    status: status ? status.replace(/\/api\/v2\/status\.json$/, '/') : null,
    api_docs: api,
  };
}

export const developer = defineEnricher({
  name: 'developer',
  title: 'Developer tools',
  description:
    'The provider’s official CLI and the command that installs it, read off the vendor’s own guide or matched by domain in Homebrew, npm and the Terraform registry; plus its API docs, Terraform provider, status page and GitHub org.',
  collections: ['hosting'],
  appliesTo: (item) => item.kind === 'provider',
  perRun: 25,
  async enrich(item, { http, log }) {
    const origin = homeOf(item);
    if (!origin) return null;
    const domain = registrableDomain(new URL(origin).hostname.replace(/^www\./, ''));
    const slug = String(item.data?.provider ?? '').toLowerCase();
    const stated = descriptorBlock(item);
    const block = stated ??
      seedBlock(domain) ?? {
        cli: null,
        api_docs: null,
        terraform: null,
        status: null,
        github: null,
        source_notes: [],
      };
    const cliStated = Boolean(stated?.cliStated);
    if (stated) delete stated.cliStated;

    if (!block.cli && !cliStated) {
      // Step 2: the registries, by domain.
      try {
        const brew = brewMatches((await brewIndex(http)).get(domain), domain);
        if (brew.length) {
          const f = brew[0];
          block.cli = {
            name: f.name,
            repo: /github\.com/.test(f.homepage) ? f.homepage : null,
            docs: f.homepage,
            install: { brew: `brew install ${f.name}` },
            verified: 'registry',
          };
          block.source_notes.push(`cli: Homebrew formula ${f.name}, homepage on ${domain}`);
        }
      } catch (err) {
        log(`[developer] brew index: ${String(err.message).slice(0, 80)}`);
      }
      if (!block.cli && slug) {
        try {
          const q = encodeURIComponent(`${slug} cli`);
          const res = await http.json(`${NPM_SEARCH}?text=${q}&size=10`, { timeoutMs: 15_000 });
          const hit = npmMatches(res?.objects, domain)[0];
          if (hit) {
            block.cli = {
              name: hit.name,
              repo: hit.links?.repository?.replace(/^git\+/, '').replace(/\.git$/, '') ?? null,
              docs: hit.links?.homepage ?? null,
              install: { npm: `npm i -g ${hit.name}` },
              verified: 'registry',
            };
            block.source_notes.push(`cli: npm package ${hit.name}, homepage on ${domain}`);
          }
        } catch (err) {
          log(`[developer] npm search: ${String(err.message).slice(0, 80)}`);
        }
      }
      if (!block.cli) {
        block.source_notes.push(`cli: none found on ${new Date().toISOString().slice(0, 10)}`);
      }
    }
    if (!block.terraform && slug) {
      try {
        const res = await http.json(
          `${TF_PROVIDERS}?filter%5Bname%5D=${encodeURIComponent(slug)}`,
          {
            timeoutMs: 15_000,
          },
        );
        const hit = terraformMatches(res?.data, slug)[0];
        if (hit) {
          const source = `${hit.namespace}/${hit.name}`;
          block.terraform = {
            source,
            docs: `https://registry.terraform.io/providers/${source}/latest/docs`,
          };
          block.source_notes.push(
            `terraform: registry, namespace ${hit.namespace} (${hit.tier ?? 'community'})`,
          );
        }
      } catch (err) {
        log(`[developer] terraform: ${String(err.message).slice(0, 80)}`);
      }
    }
    // Step 3: the conventional pages.
    const links = await conventionalLinks(http, origin);
    block.status ??= links.status;
    block.api_docs ??= links.api_docs;
    if (links.status) block.source_notes.push('status: conventional URL');
    if (links.api_docs && !block.source_notes.some((n) => n.startsWith('api_docs')))
      block.source_notes.push('api_docs: conventional URL');
    const found = block.cli || block.api_docs || block.terraform || block.status;
    if (!found && block.source_notes.length === 0) return null;
    return {
      ...block,
      domain,
      tags: [
        block.cli ? 'has-cli' : null,
        block.terraform ? 'has-terraform' : null,
        block.api_docs ? 'has-api-docs' : null,
        block.status ? 'has-status-page' : null,
      ].filter(Boolean),
    };
  },
});
