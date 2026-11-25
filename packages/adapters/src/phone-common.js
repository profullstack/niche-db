import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * What every phone source shares: a number as E.164, the tag a row is found
 * by (`num-<digits>`, the E.164 without its plus), and a guess at the kind of
 * line from the name of the carrier a block was assigned to.
 *
 * The tag is how /phone finds every row about a number across sources without
 * a column of its own: complaints, businesses and blacklist rows all carry it.
 */

/** `+15206551816` -> `num-15206551816`. */
export const numberTag = (e164) => `num-${String(e164).replace(/\D/g, '')}`;

/**
 * Any written number as E.164, or null. `region` is the ISO country to read
 * a national number in (US when the source is North American); a number
 * written with + or 00 needs none.
 */
export function toE164(raw, region = 'US') {
  const s = String(raw ?? '')
    .trim()
    .replace(/^00/, '+');
  if (!/\d{3}/.test(s)) return null;
  const p = parsePhoneNumberFromString(s, region || undefined);
  if (!p?.isPossible()) return null;
  return p.number;
}

/**
 * The carrier names that say what kind of line a block was assigned for.
 * NANPA publishes no line type; the name of the company holding the block is
 * the only open evidence, and it is the ORIGINAL holder: a number ported since
 * keeps its block. So this is labelled a guess everywhere it is shown.
 */
const WIRELESS =
  /\b(WIRELESS|CELLCO|CELLULAR|PCS\b|MOBILITY|T-MOBILE|OMNIPOINT|METROPCS|SPRINT SPECTRUM|NEW CINGULAR|US CELLULAR|NEXTEL|CRICKET|AT&T MOBILITY|VERIZON WIRELESS|DISH WIRELESS|BOOST)\b/i;
const VOIP =
  /\b(BANDWIDTH|ONVOY|TELNYX|TWILIO|LEVEL 3|LEVEL3|INTELIQUENT|PEERLESS|VONAGE|COMMIO|SINCH|NEUTRAL TANDEM|YMAX|MAGICJACK|GOOGLE|VOIP|IPIFONY|8X8|RINGCENTRAL|TELEPORT|O1 COMMUNICATIONS|CALL ONE|CENTURYLINK COMMUNICATIONS|ZAYO|LUMEN)\b/i;

/** 'wireless', 'voip' or 'landline' as a guess from a carrier name, or null. */
export function lineTypeGuess(company) {
  const s = String(company ?? '');
  if (!s.trim()) return null;
  if (WIRELESS.test(s)) return 'wireless';
  if (VOIP.test(s)) return 'voip';
  return 'landline';
}

/** "CELLCO PARTNERSHIP DBA VERIZON WIRELESS" -> "Cellco Partnership DBA Verizon Wireless". */
export function carrierName(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Dba|Llc|Pcs|Clec|Ilec|Usa|Ii|Iii|Mci)\b/g, (m) => m.toUpperCase())
    .replace(/\bAt&t\b/gi, 'AT&T')
    .replace(/\bMetropcs\b/g, 'MetroPCS');
}
