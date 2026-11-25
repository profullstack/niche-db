import { render } from '../lib/http.js';
import { parseNumber, phoneReport } from '../lib/phone.js';
import { collectionCounts } from '../lib/vehicles.js';
import { PhoneLanding, PhonePage } from '../views/phone.jsx';

/**
 * Phone numbers: /phone, one number at /phone/<digits> (and .json), and
 * /api/v1/phone/<number>. lib/phone.js builds the report.
 */

const setCache = (c, seconds) => c.header('cache-control', `public, max-age=${seconds}`);

/** The digits a number's one address uses: /phone/12025550143. */
const canonical = (raw) => parseNumber(raw)?.digits ?? null;

export function registerPhone(app) {
  app.get('/phones', (c) => c.redirect('/phone', 301));

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
      setCache(c, 60);
      return c.json(r);
    }
    if (!r.error && r.number.digits !== bare) return c.redirect(`/phone/${r.number.digits}`, 301);
    if (!r.error) setCache(c, 60);
    return c.html(
      await render(<PhonePage user={c.get('user')} report={r} />),
      r.error ? (r.status ?? 400) : 200,
    );
  });

  app.get('/api/v1/phone/:number', async (c) => {
    const raw = decodeURIComponent(c.req.param('number'));
    const r = await phoneReport(/^\d{11,15}$/.test(raw) ? `+${raw}` : raw);
    if (r.error) return c.json({ error: r.error }, r.status ?? 400);
    setCache(c, 60);
    return c.json(r);
  });
}
