import { callerAddress } from '../lib/auth-throttle.js';
import { lookupCallerId } from '../lib/caller-id.js';
import { render } from '../lib/http.js';
import { parseNumber, phoneReport } from '../lib/phone.js';
import { collectionCounts } from '../lib/vehicles.js';
import { PhoneLanding, PhonePage } from '../views/phone.jsx';

/**
 * Phone numbers: /phone, one number at /phone/<digits> (and .json), and
 * /api/v1/phone/<number>. lib/phone.js builds the report.
 */

const setCache = (c, seconds) => c.header('cache-control', `public, max-age=${seconds}`);

/** A report naming a caller is private to whoever asked; the rest caches a minute. */
const cacheFor = (c, r) =>
  r.callerId?.name ? c.header('cache-control', 'private, no-store') : setCache(c, 60);

/** The digits a number's one address uses: /phone/12025550143. */
const canonical = (raw) => parseNumber(raw)?.digits ?? null;

export function registerPhone(app) {
  app.get('/phones', (c) => c.redirect('/phone', 301));

  // Caller ID costs money per lookup, so it is a POST a person makes from the
  // page (crawlers do not submit forms) or an API call; both pass the limits
  // in lib/caller-id.js. The page then shows the cached answer.
  app.post('/phone/:number/caller-id', async (c) => {
    const n = parseNumber(`+${c.req.param('number').replace(/\D/g, '')}`);
    if (!n) return c.redirect('/phone', 303);
    const r = await lookupCallerId(n.e164, { identity: callerAddress(c) });
    const back = `/phone/${n.digits}`;
    return c.redirect(r.error ? `${back}?callerIdError=${encodeURIComponent(r.error)}` : back, 303);
  });

  const apiCallerId = async (c) => {
    const raw = decodeURIComponent(c.req.param('number'));
    const n = parseNumber(/^\d{11,15}$/.test(raw) ? `+${raw}` : raw);
    if (!n) return c.json({ error: 'not a phone number with its country code' }, 400);
    const r = await lookupCallerId(n.e164, { identity: callerAddress(c) });
    if (r.error) return c.json({ error: r.error }, r.status ?? 400);
    c.header('cache-control', 'private, no-store');
    return c.json({ number: n.e164, ...r });
  };
  app.get('/api/v1/phone/:number/caller-id', apiCallerId);
  app.post('/api/v1/phone/:number/caller-id', apiCallerId);

  app.get('/phone', async (c) => {
    const term = (c.req.query('q') ?? '').trim();
    if (term) {
      const digits = canonical(term);
      if (digits) return c.redirect(`/phone/${digits}`, 303);
      return c.html(
        await render(
          <PhoneLanding
            user={c.get('user')}
            query={term}
            error="That is not a phone number. Include the country code, e.g. +44 20 7946 0000."
          />,
        ),
        400,
      );
    }
    const counts = await collectionCounts('phone', ['exchange', 'complaint']).catch(() => null);
    setCache(c, 300);
    return c.html(
      await render(
        <PhoneLanding
          user={c.get('user')}
          counts={{
            exchanges: counts?.tags?.exchange ?? null,
            complaints: counts?.tags?.complaint ?? null,
          }}
        />,
      ),
    );
  });

  app.get('/phone/:number', async (c) => {
    const raw = decodeURIComponent(c.req.param('number'));
    const json = /\.json$/i.test(raw);
    const bare = raw.replace(/\.json$/i, '');
    // A path is always the full international number, so `+` is implied.
    const query = bare.startsWith('+') ? bare : `+${bare.replace(/\D/g, '')}`;
    const r = await phoneReport(query);
    if (json) {
      if (r.error) return c.json({ error: r.error }, r.status ?? 400);
      cacheFor(c, r);
      return c.json(r);
    }
    if (!r.error && r.number.digits !== bare) return c.redirect(`/phone/${r.number.digits}`, 301);
    if (!r.error) setCache(c, 60);
    // A page showing a caller ID name may name a private person: never cached
    // publicly, never indexed (the view sets noindex).
    if (r.callerId?.name) c.header('cache-control', 'private, no-store');
    return c.html(
      await render(
        <PhonePage user={c.get('user')} report={r} callerIdError={c.req.query('callerIdError')} />,
      ),
      r.error ? (r.status ?? 400) : 200,
    );
  });

  app.get('/api/v1/phone/:number', async (c) => {
    const raw = decodeURIComponent(c.req.param('number'));
    const r = await phoneReport(/^\d{11,15}$/.test(raw) ? `+${raw}` : raw);
    if (r.error) return c.json({ error: r.error }, r.status ?? 400);
    cacheFor(c, r);
    return c.json(r);
  });
}
