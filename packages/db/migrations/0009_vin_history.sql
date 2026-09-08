-- Vehicle history reports, and the ratings computed beside them.
--
-- Two tables, for two reasons that are not the same reason.
--
--   auto_vin_history   A title record bought from an NMVTIS provider. Unlike
--                      every other upstream this collection touches, this one
--                      costs money per VIN, so a report is kept and re-read
--                      rather than re-bought. `provider` is recorded because a
--                      deployment can change providers and a stored report
--                      must still say who answered it. Held whole in `report`:
--                      the useful field is always the one that was projected
--                      out.
--
--   auto_vin_ratings   The score we computed, with its factors. Not a cache —
--                      the rating is cheap and is recomputed on every lookup,
--                      because a recall opened this morning must move it. It
--                      is kept because the score is a claim we made about a
--                      specific car on a specific day, and a claim like that
--                      should be reconstructible later: if a seller disputes a
--                      grade, the row says what the evidence was at the time.
--
-- Neither table joins a VIN to a person. As in 0008: what was asked, never who.

create table auto_vin_history (
  vin         text primary key references auto_vin_lookups (vin) on delete cascade,
  provider    text not null,
  -- The normalised report, plus the provider's own payload under `raw`.
  report      jsonb not null default '{}',
  -- What the call cost, when the provider tells us. Null when it does not.
  cost_cents  int,
  fetched_at  timestamptz not null default now()
);
create index auto_vin_history_fetched_idx on auto_vin_history (fetched_at desc);

create table auto_vin_ratings (
  id          bigserial primary key,
  vin         text not null,
  score       int not null,
  grade       text not null,
  -- 'high', 'moderate' or 'low': how much of the picture was actually visible
  -- when this score was computed. A 92 with no title record checked is not the
  -- same object as a 92 with one, and the column keeps them distinguishable.
  confidence  text not null,
  -- Every deduction, with the evidence and the upstream that supplied it.
  factors     jsonb not null default '[]',
  -- What could not be seen. The half of the report that keeps it honest.
  unknown     jsonb not null default '[]',
  computed_at timestamptz not null default now()
);
create index auto_vin_ratings_vin_idx on auto_vin_ratings (vin, computed_at desc);
create index auto_vin_ratings_computed_idx on auto_vin_ratings (computed_at desc);
