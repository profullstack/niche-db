import { parseGeoQuery } from '@nichedb/core/geo';

/** SQL fragments share validation and an indexed envelope prefilter. */
export function geoSql(sql, raw = {}) {
  const geo = parseGeoQuery(raw);
  if (!geo) return { where: sql`true`, distance: sql`null::double precision`, geo: null };
  if (geo.bbox) {
    const [w, s, e, n] = geo.bbox;
    const where =
      w <= e
        ? sql`ndb_geo_box(i.data) && box(point(${w},${s}),point(${e},${n}))`
        : sql`(ndb_geo_box(i.data) && box(point(${w},${s}),point(180,${n})) or ndb_geo_box(i.data) && box(point(-180,${s}),point(${e},${n})))`;
    return { where, distance: sql`null::double precision`, geo };
  }
  const radiusM = geo.radius * (geo.unit === 'mi' ? 1609.344 : 1000);
  const distance = sql`ndb_geo_distance(i.data,${geo.long}::double precision,${geo.lat}::double precision)`;
  return {
    geo,
    distance,
    where: sql`(ndb_geo_box(i.data) is not null
      and ndb_geo_box(i.data) && ndb_radius_box(${geo.long}::double precision,${geo.lat}::double precision,${radiusM}::double precision)
      and ${distance} <= ${radiusM})`,
  };
}
