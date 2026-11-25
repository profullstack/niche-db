import { lineTypeGuess, numberTag } from '@nichedb/adapters/phone-common';
import * as blacklists from '@nichedb/db/blacklists';
import * as q from '@nichedb/db/queries';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { rowOut } from './vehicles.js';

/**
 * One phone number, everything open data says about it: /phone/<number>,
 * /api/v1/phone/<number>, the MCP phone_lookup tool and `nichedb phone`.
 *
 *   number     parsed by libphonenumber (Google's numbering metadata, via
 *              libphonenumber-js): valid or not, country, national format,
 *              and the line type where a country's plan says it (most do;
 *              North America does not, its mobile and fixed numbers share
 *              every range)
 *   block      for a North American number: the area code, the exchange
 *              (NPA-NXX) and the block of 1,000 it falls in, with the carrier
 *              it was ASSIGNED to (NANPA; ports are not public)
 *   reports    FCC unwanted-call complaints naming it as the caller or the
 *              call-back number, and the smshub.dev SMS blacklist
 *   businesses organisations that publish it as their own number
 *
 * It never says who owns a personal line: no open register does, and the
 * sources here keep no private person's number.
 */

const TYPE = {
  MOBILE: 'mobile',
  FIXED_LINE: 'landline',
  FIXED_LINE_OR_MOBILE: 'landline or mobile',
  TOLL_FREE: 'toll-free',
  PREMIUM_RATE: 'premium rate',
  SHARED_COST: 'shared cost',
  VOIP: 'voip',
  PERSONAL_NUMBER: 'personal number',
  PAGER: 'pager',
  UAN: 'universal access number',
  VOICEMAIL: 'voicemail',
};

/**
 * A typed number as a parse, or null. Ten digits are read as North American,
 * like the SMS blacklist does; anything else needs its country code.
 */
export function parseNumber(raw, region = 'US') {
  const s = String(raw ?? '').trim();
  if (!s || !/\d{3}/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  const text =
    s.startsWith('+') || s.startsWith('00')
      ? s.replace(/^00/, '+')
      : digits.length === 11 && digits.startsWith('1')
        ? `+${digits}`
        : s;
  const p = parsePhoneNumberFromString(text, region);
  if (!p?.isPossible()) return null;
  const type = p.getType() ?? null;
  const nanp = p.countryCallingCode === '1';
  const national = String(p.nationalNumber);
  return {
    e164: p.number,
    digits: p.number.slice(1),
    valid: p.isValid(),
    country: p.country ?? null,
    callingCode: p.countryCallingCode,
    national: p.formatNational(),
    international: p.formatInternational(),
    type: type ? (TYPE[type] ?? type.toLowerCase()) : null,
    nanp,
    npa: nanp ? national.slice(0, 3) : null,
    nxx: nanp ? national.slice(3, 6) : null,
    block: nanp ? national.slice(6, 7) : null,
  };
}

/** The exchange row and the block of 1,000 this number falls in. */
async function nanpBlock(n) {
  const [exRow, npaRow] = await Promise.all([
    q.itemByExternalId('phone', `nanp:${n.npa}-${n.nxx}`).catch(() => null),
    q.itemByExternalId('phone', `nanp:${n.npa}`).catch(() => null),
  ]);
  const exchange = rowOut(exRow);
  const areaCode = rowOut(npaRow);
  const ex = exchange?.data ?? null;
  const block = ex?.blocks?.find((b) => b.x === n.block) ?? null;
  // A pooled block can sit with a different carrier from the exchange's holder.
  const carrier =
    block && block.statusCode === 'AS' && block.company
      ? { name: block.company, ocn: block.ocn, assignedAt: block.assignedAt, level: 'block' }
      : ex?.company
        ? { name: ex.company, ocn: ex.ocn, assignedAt: ex.assignedAt, level: 'exchange' }
        : null;
  return {
    areaCode: areaCode
      ? {
          npa: n.npa,
          location: areaCode.data?.location ?? null,
          country: areaCode.data?.country ?? null,
          timeZones: areaCode.data?.timeZones ?? [],
          overlay: areaCode.data?.overlay ?? null,
          inServiceAt: areaCode.data?.inServiceAt ?? null,
        }
      : null,
    exchange: ex
      ? {
          npaNxx: `${n.npa}-${n.nxx}`,
          state: ex.state ?? null,
          rateCenter: ex.rateCenter ?? null,
          pooled: Boolean(ex.pooled),
          inService: ex.inService ?? null,
        }
      : null,
    block: block
      ? {
          x: block.x,
          range: `${n.npa}-${n.nxx}-${block.x}000 to ${block.x}999`,
          status: block.status,
        }
      : null,
    carrier: carrier
      ? {
          ...carrier,
          lineTypeGuess: lineTypeGuess(carrier.name),
          note: 'The carrier the numbers were assigned to. A number ported since keeps its block, so the carrier today can differ.',
        }
      : null,
  };
}

/** A complaint as /phone shows it; `role` says which of its numbers was looked up. */
const complaintOut = (r, e164) => ({
  filedAt: r.data?.filedAt ?? null,
  role: r.data?.caller === e164 ? 'caller' : 'call-back number',
  caller: r.data?.caller ?? null,
  callback: r.data?.callback ?? null,
  callType: r.data?.callType ?? null,
  topic: r.data?.topic ?? null,
  state: r.data?.state ?? null,
});

/** Everything about one number, or { error, status }. */
export async function phoneReport(raw) {
  const n = parseNumber(raw);
  if (!n) {
    return {
      error: 'That is not a phone number. Include the country code, e.g. +44 20 7946 0000.',
      status: 400,
    };
  }
  const tag = numberTag(n.e164);
  const phone = await q.getCollection('phone').catch(() => null);
  const [block, complaintRows, sms, tagged] = await Promise.all([
    n.nanp ? nanpBlock(n) : null,
    phone
      ? q
          .recentItems({
            collectionId: phone.id,
            tags: [tag],
            kind: 'call-complaint',
            limit: 200,
            timeoutMs: 8_000,
          })
          .catch(() => [])
      : [],
    blacklists.smsNumber(n.e164).catch(() => null),
    q.recentItems({ tags: [tag], limit: 50, timeoutMs: 8_000 }).catch(() => []),
  ]);

  const complaints = complaintRows.map(rowOut).map((r) => complaintOut(r, n.e164));
  const byType = {};
  for (const c of complaints) {
    const k = c.callType ?? 'unspecified';
    byType[k] = (byType[k] ?? 0) + 1;
  }
  const businesses = tagged
    .filter((r) => r.kind !== 'call-complaint' && r.kind !== 'phone-number')
    .map(rowOut)
    .map((r) => ({
      name: r.title,
      summary: r.summary,
      url: r.url,
      page: r.page,
      source: r.data?.source ?? null,
    }));

  return {
    number: n,
    ...(block ?? {}),
    reports: {
      fcc: {
        count: complaints.length,
        capped: complaints.length === 200,
        byType,
        first: complaints.at(-1)?.filedAt ?? null,
        last: complaints[0]?.filedAt ?? null,
        recent: complaints.slice(0, 10),
      },
      sms: sms
        ? {
            listed: true,
            reporters: sms.data?.reporters ?? null,
            reasons: sms.data?.reasons ?? null,
            lastFlaggedAt: sms.data?.lastFlaggedAt ?? null,
            lastListed: sms.data?.lastListed ?? null,
            page: `/blacklists/sms/${n.digits}`,
          }
        : { listed: false },
    },
    businesses,
    sources: [
      'libphonenumber (Google numbering metadata, Apache-2.0)',
      n.nanp ? 'NANPA area code, exchange and thousands-block reports' : null,
      'FCC Consumer Complaints Data (public domain)',
      'smshub.dev SMS blacklist',
      businesses.length ? 'businesses that publish the number (NPPES organisations)' : null,
    ].filter(Boolean),
  };
}
