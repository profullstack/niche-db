import { sql } from './index.js';
import { pgArray } from './queries.js';

/**
 * Reads and writes the automotive endpoints need.
 *
 * Two tables of their own (decoded VINs, cached places) and a handful of
 * queries that cut `items` by vehicle. A vehicle is identified in the item
 * table by its tags — the year, the make slug, the model slug — because that
 * is what every automotive adapter stamps on every row it emits.
 */

const columns = sql`
  i.*, s.slug as source_slug, s.name as source_name, s.adapter,
  c.slug as collection_slug, c.name as collection_name
`;

/* ------------------------------------------------------------------ VINs -- */

export async function getVin(vin) {
  const [row] = await sql`select * from auto_vin_lookups where vin = ${vin}`;
  return row ?? null;
}

/** A decode, kept. A second ask for the same VIN counts rather than re-decodes. */
export async function recordVin({
  vin,
  wmi,
  modelYear = null,
  make = null,
  model = null,
  bodyClass = null,
  vehicleType = null,
  decoded = {},
  checkDigitOk = null,
  source = 'vpic',
}) {
  // Columns are listed rather than built from an object: a jsonb value handed
  // to the object form goes in as a JSON *string*, and reads back quoted. The
  // ::text::jsonb cast is what the rest of the codebase uses for the same reason.
  const [row] = await sql`
    insert into auto_vin_lookups
      (vin, wmi, model_year, make, model, body_class, vehicle_type, decoded,
       check_digit_ok, source)
    values
      (${vin}, ${wmi}, ${modelYear}, ${make}, ${model}, ${bodyClass}, ${vehicleType},
       ${JSON.stringify(decoded ?? {})}::text::jsonb, ${checkDigitOk}, ${source})
    on conflict (vin) do update set
      lookup_count = auto_vin_lookups.lookup_count + 1,
      last_seen_at = now(),
      model_year   = coalesce(excluded.model_year, auto_vin_lookups.model_year),
      make         = coalesce(excluded.make, auto_vin_lookups.make),
      model        = coalesce(excluded.model, auto_vin_lookups.model),
      body_class   = coalesce(excluded.body_class, auto_vin_lookups.body_class),
      vehicle_type = coalesce(excluded.vehicle_type, auto_vin_lookups.vehicle_type),
      decoded      = excluded.decoded,
      decoded_at   = now()
    returning *
  `;
  return row;
}

/** Asked about a second time, and a third. The demand signal the endpoint generates. */
export async function touchVin(vin) {
  const [row] = await sql`
    update auto_vin_lookups
       set lookup_count = lookup_count + 1, last_seen_at = now()
     where vin = ${vin}
    returning *
  `;
  return row ?? null;
}

export async function vinStats() {
  const [row] = await sql`
    select count(*)::int as vins,
           coalesce(sum(lookup_count), 0)::int as lookups,
           count(distinct wmi)::int as manufacturers
      from auto_vin_lookups
  `;
  return row ?? { vins: 0, lookups: 0, manufacturers: 0 };
}

/* -------------------------------------------------------------- baseline -- */

/**
 * What an ordinary car's complaints look like, measured rather than assumed.
 *
 * A rate on its own says nothing. Eight per cent of a model's complaints
 * mentioning a crash sounds alarming until you know that eight per cent is
 * roughly what every model runs at, because people who have been in a crash
 * are more likely to file. Scoring against zero therefore marks down every car
 * ever built, which is the same as scoring nothing at all.
 *
 * This is the number that fixes it, and it is the one thing here the site can
 * answer that the upstreams cannot: the collection has already ingested
 * complaints across every make and model year it has walked, so the population
 * average is a single aggregate over rows we already hold. A model is then
 * scored on how far it sits from ordinary, not on how far it sits from
 * perfect.
 *
 * Returns null when the corpus is too thin to average, and the caller falls
 * back to fixed reference points and says so.
 */
export async function complaintBaseline({ minimum = 5000 } = {}) {
  const [row] = await sql`
    select
      count(*)::int as complaints,
      count(*) filter (where (i.data->>'crash')::boolean)::int as crashes,
      count(*) filter (where (i.data->>'fire')::boolean)::int as fires,
      coalesce(sum((i.data->>'injuries')::int), 0)::int as injuries,
      coalesce(sum((i.data->>'deaths')::int), 0)::int as deaths
    from items i join collections c on c.id = i.collection_id
    where c.slug = 'automotive' and i.kind = 'complaint'
      and i.data ? 'crash'
  `;
  if (!row || row.complaints < minimum) return null;
  return {
    complaints: row.complaints,
    crashRate: row.crashes / row.complaints,
    fireRate: row.fires / row.complaints,
    harmRate: (row.injuries + row.deaths * 3) / row.complaints,
    measuredAt: new Date().toISOString(),
  };
}

/* --------------------------------------------------------------- history -- */

/**
 * A bought title record, kept.
 *
 * Every other upstream here is free, so a cache is a courtesy. This one is
 * not: an NMVTIS report costs money per VIN, and buying the same VIN twice
 * because somebody reloaded the page is money on the floor. The TTL is
 * generous for the same reason — a title record changes when the car is sold
 * or written off, which is not this week.
 */
export async function getVinHistory(vin, maxAgeSeconds) {
  const [row] = await sql`
    select * from auto_vin_history
     where vin = ${vin} and fetched_at > now() - make_interval(secs => ${maxAgeSeconds})
  `;
  return row ?? null;
}

export async function putVinHistory({ vin, provider, report, costCents = null }) {
  const [row] = await sql`
    insert into auto_vin_history (vin, provider, report, cost_cents)
    values (${vin}, ${provider}, ${JSON.stringify(report ?? {})}::text::jsonb, ${costCents})
    on conflict (vin) do update set
      provider   = excluded.provider,
      report     = excluded.report,
      cost_cents = coalesce(excluded.cost_cents, auto_vin_history.cost_cents),
      fetched_at = now()
    returning *
  `;
  return row ?? null;
}

/**
 * The score we published for a VIN, on the day we published it.
 *
 * Written every time a rating is computed rather than upserted, because the
 * point is the trail: a grade that fell when a recall opened should be visible
 * as a grade that fell, and a seller disputing today's number is entitled to
 * see what the evidence was when it was produced.
 */
export async function recordRating({ vin, score, grade, confidence, factors = [], unknown = [] }) {
  if (!vin) return null;
  const [row] = await sql`
    insert into auto_vin_ratings (vin, score, grade, confidence, factors, unknown)
    values (${vin}, ${score}, ${grade}, ${confidence},
            ${JSON.stringify(factors)}::text::jsonb, ${JSON.stringify(unknown)}::text::jsonb)
    returning *
  `;
  return row ?? null;
}

/** Every score this VIN has been given, newest first. */
export async function ratingHistory(vin, { limit = 20 } = {}) {
  return sql`
    select score, grade, confidence, computed_at
      from auto_vin_ratings
     where vin = ${vin}
     order by computed_at desc
     limit ${Math.min(Math.max(1, limit), 100)}
  `;
}

/* ---------------------------------------------------------------- places -- */

export async function getPlaces(key, maxAgeSeconds) {
  const [row] = await sql`
    select * from auto_place_cache
     where key = ${key} and fetched_at > now() - make_interval(secs => ${maxAgeSeconds})
  `;
  return row?.places ?? null;
}

export async function putPlaces(key, kind, places) {
  await sql`
    insert into auto_place_cache (key, kind, places)
    values (${key}, ${kind}, ${JSON.stringify(places ?? [])}::text::jsonb)
    on conflict (key) do update set places = excluded.places, fetched_at = now()
  `;
}

/* ----------------------------------------------------------- vehicle rows -- */

/**
 * Items stamped with this vehicle. `tags` carries the year, the make and the
 * model, so the match is an array containment rather than a text search.
 */
export async function itemsForVehicle({ tags, kinds = [], limit = 50 }) {
  if (!tags?.length) return [];
  return sql`
    select ${columns}
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where c.slug = 'automotive'
      and i.tags @> ${pgArray(tags)}::text[]
      and (${kinds.length === 0} or i.kind = any(${pgArray(kinds)}::text[]))
    order by i.published_at desc nulls last, i.id desc
    limit ${Math.min(Math.max(1, limit), 200)}
  `;
}

/** Distinct makes in the catalogue, from the model rows the EPA feed lands. */
export async function catalogMakes({ year = null } = {}) {
  return sql`
    select i.data->>'make' as make, count(*)::int as models,
           min((i.data->>'year')::int) as first_year,
           max((i.data->>'year')::int) as last_year
    from items i join collections c on c.id = i.collection_id
    where c.slug = 'automotive' and i.kind = 'model' and i.data ? 'make'
      and (${year === null} or (i.data->>'year')::int = ${year ?? 0})
    group by 1 order by 1
  `;
}

export async function catalogModels({ make, year = null }) {
  return sql`
    select i.id, i.title, i.url, i.data->>'model' as model,
           (i.data->>'year')::int as year, i.data->'spec' as spec,
           jsonb_array_length(coalesce(i.data->'trims', '[]'::jsonb)) as trims
    from items i join collections c on c.id = i.collection_id
    where c.slug = 'automotive' and i.kind = 'model'
      and lower(i.data->>'make') = lower(${make})
      and (${year === null} or (i.data->>'year')::int = ${year ?? 0})
    order by (i.data->>'year')::int desc, i.data->>'model'
    limit 500
  `;
}

export async function catalogYears({ make = null } = {}) {
  return sql`
    select (i.data->>'year')::int as year, count(*)::int as models
    from items i join collections c on c.id = i.collection_id
    where c.slug = 'automotive' and i.kind = 'model' and i.data ? 'year'
      and (${make === null} or lower(i.data->>'make') = lower(${make ?? ''}))
    group by 1 order by 1 desc
  `;
}

/** What the collection holds, for the page and for llms.txt. */
export async function automotiveStats() {
  const [row] = await sql`
    select
      count(*) filter (where i.kind = 'model')::int as models,
      count(*) filter (where i.kind = 'recall')::int as recalls,
      count(*) filter (where i.kind = 'complaint')::int as complaints,
      count(*) filter (where i.kind = 'safety-rating')::int as ratings,
      count(distinct i.data->>'make') filter (where i.kind = 'model')::int as makes
    from items i join collections c on c.id = i.collection_id
    where c.slug = 'automotive'
  `;
  return row ?? { models: 0, recalls: 0, complaints: 0, ratings: 0, makes: 0 };
}
