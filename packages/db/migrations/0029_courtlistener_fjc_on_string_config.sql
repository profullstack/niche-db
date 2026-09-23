-- 0028 meant to turn the FJC Integrated Database on for the seeded catalogue
-- source, and in production it matched nothing.
--
-- `insertSource` writes `${JSON.stringify(config)}::jsonb`, and Bun sends that
-- parameter as a JSON string, so a seeded source's config is stored as a jsonb
-- STRING holding the object's text (`"{\"fjc\":\"false\",...}"`), not as the
-- object. `config ->> 'fjc'` on a string is null, so 0028's WHERE was false.
-- The readers cope with both forms (the string is parsed), which is why
-- nothing else noticed.
--
-- This reads the object out of either form, and writes it back in the form the
-- row already had, so the row stays what the code that wrote it expects. A
-- config that does not say the seeded 'false' is left alone, as in 0028.

update sources
   set config = case
         when jsonb_typeof(config) = 'string'
           then to_jsonb((((config #>> '{}')::jsonb) || '{"fjc": "true"}'::jsonb)::text)
         else config || '{"fjc": "true"}'::jsonb
       end,
       updated_at = now()
 where adapter = 'courtlistener-catalog'
   and (case
          when jsonb_typeof(config) = 'string' then (config #>> '{}')::jsonb
          else config
        end) ->> 'fjc' = 'false';
