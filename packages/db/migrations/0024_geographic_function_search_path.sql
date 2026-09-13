-- Also repair installations where 0023 succeeded with an empty items table.
-- Existing populated installations rolled 0023 back and use its repaired
-- definitions first. Keep the same path for calls during CREATE INDEX/REINDEX.
alter function ndb_coord(text, double precision) set search_path from current;
alter function ndb_geo_shape(jsonb) set search_path from current;
alter function ndb_distance(double precision, double precision, double precision, double precision) set search_path from current;
alter function ndb_radius_box(double precision, double precision, double precision) set search_path from current;
alter function ndb_geo_box(jsonb) set search_path from current;
alter function ndb_polygon_distance(jsonb, double precision, double precision) set search_path from current;
alter function ndb_geo_distance(jsonb, double precision, double precision) set search_path from current;
