import { GeoQueryError, geoQueryFields } from '@nichedb/core/geo';

export function scannerContextOptions(raw = {}) {
  const date = (key) => {
    const value = raw[key];
    if (value === undefined || value === null || value === '') return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new GeoQueryError(`${key} must be an ISO date`);
    return d.toISOString();
  };
  const from = date('from');
  const to = date('to');
  if (from && to && from >= to) throw new GeoQueryError('from must precede to');
  return { ...geoQueryFields(raw), from, to };
}
export const SCANNER_CONTEXT_NOTE =
  'Reported incidents in the coverage area; not verified links to scanner transmissions. An empty result does not imply no crime.';
