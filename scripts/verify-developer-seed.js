/**
 * Re-read every vendor install guide the developer seed cites and record
 * which of its commands the page still carries, verbatim.
 *
 *   bun scripts/verify-developer-seed.js
 *
 * Writes packages/enrichers/test/fixtures/developer-seed-verified.json. The
 * enricher test fails on any seed command the fixture does not list, so a
 * vendor changing its guide shows up as a failing test rather than as a
 * stale command on nichedb.dev. A GitHub URL is read as its raw README (or
 * the raw file a blob URL names), because github.com pages no longer carry
 * the README in the HTML a plain fetch gets.
 */
import { writeFileSync } from 'node:fs';
import { DEVELOPER_SEED } from '../packages/enrichers/src/developer-seed.js';

const UA = 'nichedb/1.0 (+https://nichedb.dev; verify-developer-seed)';

function rawFor(url) {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/blob\/([^/]+)\/(.+))?\/?$/);
  if (!m) return [url];
  const [, owner, repo, ref, path] = m;
  if (path) return [`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`];
  return [`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`];
}

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ');

/** A JSON-escaped script payload, with its \\n and \\" undone so a command reads as typed. */
const unescapeJs = (s) =>
  s
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\"/g, '"')
    .replace(/\\\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

const out = {};
for (const [domain, row] of DEVELOPER_SEED) {
  if (!row.cli) continue;
  const commands = Object.values(row.cli.install ?? {}).flatMap((c) => c.split(' && '));
  const urls = rawFor(row.cli.docs);
  let text = '';
  let status = null;
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(25_000),
      });
      status = res.status;
      // Both the visible text and the raw markup: docs sites built on Next.js
      // (render.com, cloudflare, netlify) ship the install commands inside a
      // script payload the HTML strip would drop.
      const body = await res.text();
      text += `${strip(body)}\n${unescapeJs(body)}`;
    } catch (err) {
      status = String(err.message).slice(0, 60);
    }
  }
  const verified = commands.filter((c) => text.includes(c));
  const missing = commands.filter((c) => !text.includes(c));
  out[domain] = {
    url: row.cli.docs,
    fetched: urls,
    status,
    verified,
    missing,
    at: new Date().toISOString().slice(0, 10),
  };
  console.log(
    `${domain.padEnd(20)} ${String(status).padEnd(4)} ${verified.length}/${commands.length}${missing.length ? `  missing: ${missing.join(' | ')}` : ''}`,
  );
}
writeFileSync(
  new URL('../packages/enrichers/test/fixtures/developer-seed-verified.json', import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
