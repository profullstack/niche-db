-- Geographic reads without a PostGIS dependency. Expression index also covers
-- existing rows; no re-ingestion or stored-column table rewrite is required.
create function ndb_coord(v text, lim double precision) returns double precision
language plpgsql immutable parallel safe as $$
declare n double precision;
begin
  if v is null or btrim(v) = '' then return null; end if;
  n := v::double precision;
  if n between -lim and lim then return n; end if;
  return null;
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end $$;

-- Coverage takes precedence over a receiver/site point. Unknown or malformed
-- coverage must not silently fall back to a receiver's physical location.
create function ndb_geo_shape(d jsonb) returns jsonb
language plpgsql immutable parallel safe as $$
declare p jsonb; x double precision; y double precision;
begin
  if d ? 'coverage' and d->'coverage' <> 'null'::jsonb then return d->'coverage'; end if;
  foreach p in array array[d->'location', d->'place', d->'position', d->'geometry', d] loop
    if p->>'type' in ('Point', 'Polygon', 'MultiPolygon', 'Circle') then return p; end if;
    y := ndb_coord(coalesce(p->>'lat', p->>'latitude'), 90);
    x := ndb_coord(coalesce(p->>'long', p->>'lon', p->>'lng', p->>'longitude'), 180);
    if x is not null and y is not null then
      return jsonb_build_object('type', 'Point', 'coordinates', jsonb_build_array(x, y));
    end if;
  end loop;
  return null;
end $$;

create function ndb_distance(x1 double precision, y1 double precision, x2 double precision, y2 double precision)
returns double precision language sql immutable strict parallel safe as $$
  select 12742017.6 * asin(sqrt(least(1.0, greatest(0.0,
    power(sin(radians(y2-y1)/2),2) + cos(radians(y1))*cos(radians(y2))*power(sin(radians(x2-x1)/2),2)))));
$$;

-- A conservative longitude/latitude envelope. A crossing or polar envelope is
-- widened to the full longitude range so the index never loses a match.
create function ndb_radius_box(x double precision, y double precision, radius_m double precision)
returns box language plpgsql immutable strict parallel safe as $$
declare dy double precision := degrees(radius_m / 6371008.8); dx double precision;
begin
  if abs(y) + dy >= 90 then dx := 180;
  else dx := degrees(asin(least(1.0, sin(radius_m / 6371008.8) / cos(radians(y))))); end if;
  if x-dx < -180 or x+dx > 180 then return box(point(-180, greatest(-90,y-dy)), point(180,least(90,y+dy))); end if;
  return box(point(x-dx, greatest(-90,y-dy)), point(x+dx,least(90,y+dy)));
end $$;

create function ndb_geo_box(d jsonb) returns box
language plpgsql immutable parallel safe as $$
declare g jsonb := ndb_geo_shape(d); p jsonb; ring jsonb; poly jsonb; polys jsonb;
  x double precision; y double precision; r double precision;
  west double precision := 180; east double precision := -180;
  south double precision := 90; north double precision := -90;
begin
  if g->>'type' in ('Point','Circle') then
    x := ndb_coord(g#>>'{coordinates,0}',180); y := ndb_coord(g#>>'{coordinates,1}',90);
    if x is null or y is null then return null; end if;
    if g->>'type' = 'Point' then return box(point(x,y),point(x,y)); end if;
    r := ndb_coord(g->>'radius_m',1000000);
    if r is null or r < 0 then return null; end if;
    return ndb_radius_box(x,y,r);
  end if;
  if g->>'type' not in ('Polygon','MultiPolygon') then return null; end if;
  polys := case when g->>'type' = 'Polygon' then jsonb_build_array(g->'coordinates') else g->'coordinates' end;
  for poly in select value from jsonb_array_elements(polys) loop
    for ring in select value from jsonb_array_elements(poly) loop
      if jsonb_array_length(ring) < 4 or ring->0 <> ring->(jsonb_array_length(ring)-1) then return null; end if;
      for p in select value from jsonb_array_elements(ring) loop
        x := ndb_coord(p->>0,180); y := ndb_coord(p->>1,90);
        if x is null or y is null then return null; end if;
        west := least(west,x); east := greatest(east,x); south := least(south,y); north := greatest(north,y);
      end loop;
    end loop;
  end loop;
  if east < west then return null; end if;
  if east-west > 180 then west := -180; east := 180; end if;
  -- Polygon edges follow GeoJSON's straight longitude/latitude segments.
  return box(point(west,south),point(east,north));
exception when data_exception then return null;
end $$;

-- Local GeoJSON polygon distance: containment honours holes; edges are
-- subdivided before spherical distance so longitude/latitude segments follow
-- the same path as map renderers (rather than a single great-circle arc).
create function ndb_polygon_distance(poly jsonb, x double precision, y double precision)
returns double precision language plpgsql immutable parallel safe as $$
declare ring jsonb; p jsonb; pts text; px double precision; py double precision;
  firstx double precision; prevx double precision; prevy double precision;
  qx double precision; inside boolean := false; hole boolean := false; idx integer := 0;
  best double precision := 'Infinity'; dx double precision; dy double precision;
  t double precision; n integer; j integer; ax double precision; ay double precision;
  bx double precision; byy double precision; scale double precision;
begin
  for ring in select value from jsonb_array_elements(poly) loop
    pts := ''; prevx := null; firstx := null;
    for p in select value from jsonb_array_elements(ring) loop
      px := (p->>0)::double precision; py := (p->>1)::double precision;
      if firstx is null then firstx := px; end if;
      if prevx is not null then
        while px-prevx > 180 loop px := px-360; end loop;
        while px-prevx < -180 loop px := px+360; end loop;
        n := greatest(1,ceil(greatest(abs(px-prevx),abs(py-prevy))*10)::integer);
        for j in 0..n-1 loop
          ax := prevx+(px-prevx)*j/n; ay := prevy+(py-prevy)*j/n;
          bx := prevx+(px-prevx)*(j+1)/n; byy := prevy+(py-prevy)*(j+1)/n;
          qx := x + 360*round((ax-x)/360);
          scale := cos(radians(y)); dx := (bx-ax)*scale; dy := byy-ay;
          t := case when dx*dx+dy*dy=0 then 0 else greatest(0,least(1,((qx-ax)*scale*dx+(y-ay)*dy)/(dx*dx+dy*dy))) end;
          best := least(best,ndb_distance(x,y,ax+(bx-ax)*t,ay+(byy-ay)*t));
        end loop;
      end if;
      pts := pts || case when pts = '' then '' else ',' end || '(' || px || ',' || py || ')';
      prevx := px; prevy := py;
    end loop;
    qx := x + 360*round((firstx-x)/360);
    if idx=0 then inside := ('('||pts||')')::polygon @> point(qx,y);
    elsif ('('||pts||')')::polygon @> point(qx,y) then hole := true; end if;
    idx := idx+1;
  end loop;
  if inside and not hole then return 0; end if;
  return best;
end $$;

create function ndb_geo_distance(d jsonb, x double precision, y double precision)
returns double precision language plpgsql immutable strict parallel safe as $$
declare g jsonb := ndb_geo_shape(d); poly jsonb; best double precision := 'Infinity';
begin
  if ndb_geo_box(d) is null then return null; end if;
  case g->>'type'
    when 'Point' then return ndb_distance(x,y,(g#>>'{coordinates,0}')::double precision,(g#>>'{coordinates,1}')::double precision);
    when 'Circle' then return greatest(0,ndb_distance(x,y,(g#>>'{coordinates,0}')::double precision,(g#>>'{coordinates,1}')::double precision)-(g->>'radius_m')::double precision);
    when 'Polygon' then return ndb_polygon_distance(g->'coordinates',x,y);
    when 'MultiPolygon' then
      for poly in select value from jsonb_array_elements(g->'coordinates') loop
        best := least(best,ndb_polygon_distance(poly,x,y));
      end loop;
      return best;
    else return null;
  end case;
exception when data_exception then return null;
end $$;

create index items_geo_box_idx on items using gist (ndb_geo_box(data)) where ndb_geo_box(data) is not null;
