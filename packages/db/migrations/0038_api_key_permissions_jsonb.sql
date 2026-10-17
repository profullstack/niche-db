-- API keys' `permissions` and `metadata` were stored as a jsonb STRING, not
-- the object it spells, the trap 0010 repaired elsewhere: saveKey cast a
-- stringified object straight to jsonb, and Bun's driver passes that through
-- as a string (more than once over, so some rows are strings of strings).
-- Nothing read a permission until the lyrics key, which carries
-- `lyrics: true` and was refused because `"…".lyrics` is undefined. The
-- writes now cast through text; this unwraps what the old ones left, as many
-- levels as there are, and leaves a correct row alone.

do $$
begin
  for i in 1..8 loop
    update api_keys set permissions = (permissions #>> '{}')::jsonb
     where jsonb_typeof(permissions) = 'string';
    update api_keys set metadata = (metadata #>> '{}')::jsonb
     where jsonb_typeof(metadata) = 'string';
    exit when not exists (
      select 1 from api_keys
       where jsonb_typeof(permissions) = 'string' or jsonb_typeof(metadata) = 'string'
    );
  end loop;
end $$;
