import { defineAdapter } from '@nichedb/core/adapter';

/**
 * The SMS blacklist, from smshub.dev.
 *
 * When someone on smshub flags a number that texted them as spam or a scam,
 * smshub blocks it for them and counts it in a public export: one row per
 * sending number with how many people flagged it, for which reason, and when.
 * Nothing about who flagged it or which line it texted leaves smshub.
 *
 * The export is the whole current list every time, so a run rewrites
 * `lastListed` on every row it sees. A number everyone unblocked stops being
 * seen, keeps its row as history, and drops off /blacklists/sms once its
 * `lastListed` is older than the window there.
 */

export const EXPORT_URL = 'https://smshub.dev/api/v1/blacklist/sms';
const PAGE_BASE = 'https://nichedb.dev/blacklists/sms';

const REASONS = ['spam', 'scam'];

const E164 = /^\+[1-9]\d{6,14}$/;

const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

const when = (v) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/** `+18885551234` as `+1 888-555-1234`; anything outside NANP stays as it came. */
export function formatNumber(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : e164;
}

/** One flagged number, or null when the export row has no usable E.164 number or no reason. */
export function toItem(row, today = new Date()) {
  const number = typeof row?.number === 'string' ? row.number.replace(/[\s().-]/g, '') : '';
  if (!E164.test(number)) return null;
  const reasons = Object.fromEntries(REASONS.map((r) => [r, count(row.reasons?.[r])]));
  const flags = reasons.spam + reasons.scam;
  if (flags === 0) return null;
  const reporters = Math.max(count(row.reporters), 1);
  const first = when(row.firstFlaggedAt);
  const last = when(row.lastFlaggedAt) ?? first;
  const label = reasons.scam >= reasons.spam ? 'scam' : 'spam';
  const display = formatNumber(number);
  const counts = REASONS.filter((r) => reasons[r])
    .map((r) => `${reasons[r]} ${r}`)
    .join(', ');

  return {
    externalId: `sms:${number}`,
    kind: 'phone-number',
    title: display,
    summary: `Flagged as ${label} by ${reporters} smshub ${reporters === 1 ? 'user' : 'users'} (${counts}).`,
    url: `${PAGE_BASE}/${number.slice(1)}`,
    publishedAt: first,
    tags: [
      'sms',
      'smshub',
      'status:listed',
      ...REASONS.filter((r) => reasons[r]).map((r) => `reason:${r}`),
      number.startsWith('+1') ? 'nanp' : null,
    ].filter(Boolean),
    data: {
      number,
      display,
      reasons,
      reporters,
      blockedMessages: count(row.blockedMessages),
      firstFlaggedAt: first,
      lastFlaggedAt: last,
      lastListed: today.toISOString().slice(0, 10),
      source: 'smshub',
    },
  };
}

export const smshubBlacklist = defineAdapter({
  name: 'smshub-blacklist',
  title: 'smshub SMS blacklist',
  collection: 'blacklists',
  description:
    'Phone numbers smshub.dev users flagged as spam or scam texters, one row per sending number with the spam and scam counts, how many people flagged it, and when. Published at nichedb.dev/blacklists/sms.',
  docs: 'https://nichedb.dev/blacklists/sms',
  kinds: ['phone-number'],
  cadenceMinutes: 15,
  configFields: [],
  defaults: {},
  defaultSources: [{ slug: 'smshub-sms-blacklist', name: 'SMS blacklist: smshub.dev', config: {} }],
  async pull({ http, log }) {
    const body = await http.json(EXPORT_URL, { timeoutMs: 20_000 });
    const rows = Array.isArray(body?.numbers) ? body.numbers : [];
    const today = new Date();
    const seen = new Set();
    const items = [];
    for (const row of rows) {
      const item = toItem(row, today);
      if (item && !seen.has(item.externalId)) {
        seen.add(item.externalId);
        items.push(item);
      }
    }
    log(`${items.length} flagged numbers of ${rows.length} exported`);
    return { items, note: `${items.length} numbers` };
  },
});
