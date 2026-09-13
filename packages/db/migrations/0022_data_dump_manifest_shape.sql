-- Bun binds an explicitly JSONB parameter as a JSON string when given serialized
-- text. Repair that representation and reject malformed manifests on publication.
update data_dumps set manifest = (manifest #>> '{}')::jsonb
where jsonb_typeof(manifest) = 'string';

alter table data_dumps add constraint data_dumps_manifest_shape
  check (jsonb_typeof(manifest) = 'object'
         and coalesce(jsonb_typeof(manifest->'parts') = 'array', false));
