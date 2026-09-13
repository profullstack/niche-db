#!/usr/bin/env bun
/**
 * Re-score a storefront survey from the evidence it recorded.
 *
 * The survey writes every mark that matched on every host, so a change to
 * the decision rule (which marks decide) can be applied to a finished table
 * without visiting a single host again. The rule here is the one
 * `fingerprint()` applies today: a platform needs a strong mark or its
 * cookie; two weak marks never decide. A row that no longer decides loses
 * its platform and its listing; nothing else on it changes.
 *
 *   bun scripts/rescore-storefront-survey.js   # rewrites the fixture in place
 */
import { readFile, writeFile } from 'node:fs/promises';
import { PLATFORMS } from '../packages/adapters/src/storefront-platforms.js';

const FILE = new URL('../packages/adapters/test/fixtures/storefront-survey.json', import.meta.url);

export function rescore(survey) {
  const hosts = survey.hosts.map((h) => {
    if (!h.platform) return h;
    const known = PLATFORMS[h.platform];
    // A recorded strong mark only still counts if the platform still lists it as strong.
    const decided =
      known &&
      h.evidence.some(
        (e) =>
          e === 'cookie' ||
          (e.startsWith('strong:') &&
            known.strong.some((re) => re.source.slice(0, 40) === e.slice(7))),
      );
    if (decided) return h;
    return { ...h, platform: null, listing: null, score: 0, rescored: 'weak marks only' };
  });
  const counts = {};
  const bucket = (r) =>
    r.platform ?? (r.error ? `unreachable:${r.error}` : r.challenged ? 'challenged' : 'none');
  for (const r of hosts) counts[bucket(r)] = (counts[bucket(r)] ?? 0) + 1;
  const listings = {};
  for (const r of hosts)
    if (r.platform && r.listing) listings[r.platform] = (listings[r.platform] ?? 0) + 1;
  return { ...survey, counts, listings, hosts };
}

if (import.meta.main) {
  const survey = JSON.parse(await readFile(FILE, 'utf8'));
  const out = rescore(survey);
  await writeFile(FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    JSON.stringify({ corpus: out.corpus, counts: out.counts, listings: out.listings }, null, 2),
  );
}
