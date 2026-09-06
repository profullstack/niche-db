-- Repair jsonb columns that hold a STRING instead of the thing it spells.
--
-- Bun's driver passes a string parameter cast to `jsonb` straight through
-- rather than parsing it, so a value written as a stringified object landed as
-- a jsonb string: `"{}"` rather than `{}`. The writes now cast through `text`,
-- which stores the real structure, and this repairs what the old ones left.
--
-- It shipped visibly. Every opportunity page rendered a "How that score is
-- made" list with two entries, `0` and `1`, holding a brace each, because
-- Object.keys of a string is its character indices.
--
-- `#>> '{}'` takes the text a jsonb string contains, and casting that back to
-- jsonb parses it. Guarded by jsonb_typeof so a row that is already correct is
-- left alone, and so re-running costs nothing.

update opportunities
set dimensions = (dimensions #>> '{}')::jsonb
where jsonb_typeof(dimensions) = 'string';

update niche_claims
set answers = (answers #>> '{}')::jsonb
where jsonb_typeof(answers) = 'string';

update contribution_events
set evidence = (evidence #>> '{}')::jsonb
where jsonb_typeof(evidence) = 'string';

update knowledge_audit_logs
set detail = (detail #>> '{}')::jsonb
where jsonb_typeof(detail) = 'string';

update agent_questions
set options = (options #>> '{}')::jsonb
where jsonb_typeof(options) = 'string';

update agent_questions
set related_resource_ids = (related_resource_ids #>> '{}')::jsonb
where jsonb_typeof(related_resource_ids) = 'string';
