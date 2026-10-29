import * as blacklists from '@nichedb/db/blacklists';
import { render } from '../lib/http.js';
import { BlacklistsIndexPage, SmsBlacklistPage, SmsNumberPage } from '../views/blacklists.jsx';

/**
 * Blacklists: /blacklists, /blacklists/sms (page, .txt, .json), one number at
 * /blacklists/sms/<number>, and /api/v1/blacklists/sms[/<number>]. The rows
 * come from the smshub-blacklist source; the live list is what smshub's export
 * named in the last day.
 */

const LISTED_DAYS = 1;

/**
 * A phone number as E.164, or null. Ten digits are taken as North American,
 * eleven starting with 1 likewise; anything else needs its country code.
 */
export function normaliseNumber(raw) {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  let e164;
  if (s.startsWith('+')) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  else e164 = `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

const listedSince = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - LISTED_DAYS);
  return d.toISOString().slice(0, 10);
};

async function lookup(number) {
  const row = await blacklists.smsNumber(number);
  if (!row) return null;
  return { ...row, listed: String(row.data?.lastListed ?? '') >= listedSince() };
}

const publicRow = ({ data }) => ({
  number: data.number,
  reasons: data.reasons,
  reporters: data.reporters,
  firstFlaggedAt: data.firstFlaggedAt,
  lastFlaggedAt: data.lastFlaggedAt,
});

export function registerBlacklists(app) {
  app.get('/blacklists', async (c) => {
    const rows = await blacklists.listedSmsNumbers({ days: LISTED_DAYS });
    return c.html(
      await render(<BlacklistsIndexPage user={c.get('user')} smsCount={rows.length} />),
    );
  });

  app.get('/blacklists/sms.txt', async (c) => {
    const rows = await blacklists.listedSmsNumbers({ days: LISTED_DAYS });
    c.header('cache-control', 'public, max-age=900');
    return c.text(
      `# nichedb.dev SMS blacklist: numbers smshub.dev users flagged as spam or scam, ${new Date().toISOString()}\n# ${rows.length} numbers, E.164. Free to use.\n${rows.map((r) => r.data.number).join('\n')}\n`,
    );
  });

  app.get('/blacklists/sms.json', async (c) => {
    const rows = await blacklists.listedSmsNumbers({ days: LISTED_DAYS });
    c.header('cache-control', 'public, max-age=900');
    return c.json({
      generatedAt: new Date().toISOString(),
      count: rows.length,
      numbers: rows.map(publicRow),
    });
  });

  app.get('/blacklists/sms', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q) {
      const number = normaliseNumber(q);
      if (number) return c.redirect(`/blacklists/sms/${number.slice(1)}`, 303);
      const rows = await blacklists.listedSmsNumbers({ days: LISTED_DAYS });
      return c.html(
        await render(
          <SmsBlacklistPage
            user={c.get('user')}
            rows={rows}
            query={q}
            error="That is not a phone number. Include the country code, e.g. +44 20 7946 0000."
          />,
        ),
        400,
      );
    }
    const rows = await blacklists.listedSmsNumbers({ days: LISTED_DAYS });
    return c.html(await render(<SmsBlacklistPage user={c.get('user')} rows={rows} />));
  });

  app.get('/blacklists/sms/:number', async (c) => {
    const number = normaliseNumber(`+${c.req.param('number').replace(/^\+/, '')}`);
    if (!number) return c.notFound();
    const entry = await lookup(number);
    return c.html(
      await render(<SmsNumberPage user={c.get('user')} number={number} entry={entry} />),
    );
  });

  app.get('/api/v1/blacklists/sms', async (c) => {
    const rows = await blacklists.listedSmsNumbers({ days: LISTED_DAYS });
    return c.json({ count: rows.length, numbers: rows.map(publicRow) });
  });

  app.get('/api/v1/blacklists/sms/:number', async (c) => {
    const number = normaliseNumber(`+${c.req.param('number').replace(/^\+/, '')}`);
    if (!number) return c.json({ error: 'not a phone number with its country code' }, 400);
    const entry = await lookup(number);
    if (!entry) return c.json({ number, listed: false, everListed: false });
    return c.json({
      ...publicRow(entry),
      listed: entry.listed,
      everListed: true,
      lastListed: entry.data.lastListed,
    });
  });
}
