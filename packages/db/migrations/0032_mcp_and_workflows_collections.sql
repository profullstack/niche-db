-- MCP servers and agent workflows each get a collection, and the MCP servers
-- move out of `extensions`.
--
-- `extensions` was "things you install into something": Firefox add-ons, VS
-- Code extensions and MCP servers. That was a fair description when the only
-- MCP source was the official registry. It stopped being one the moment this
-- collection started reading six sources of them, because an MCP server is not
-- a browser add-on in any way a reader cares about, and because the questions
-- worth asking of a directory of servers -- which are remote, which are
-- packaged, which are actually called -- are not questions you ask of a
-- Firefox theme.
--
-- The same care as 0010_weather_collection about not losing what exists.
-- Seeding is idempotent by (collection, slug), so leaving the source row where
-- it is would have the next boot create a SECOND `mcp-servers` source under
-- `mcp` and both would poll the registry forever. So the rows are moved:
--
--   * the `mcp-servers` source, with its cursor and run history
--   * every item it has already ingested, so the archive survives the move
--   * the `new-mcp-servers` feed, keeping its slug, because a feed URL is a
--     promise to whoever is polling it
--
-- Every statement is conditional on the rows being there, so a fresh database
-- reaches the same place by seeding instead.

insert into collections (slug, name, description)
values (
  'mcp',
  'MCP servers',
  'Every Model Context Protocol server anyone has published, from six sources that each know something the others do not: the official registry knows what was published and with which packages, Docker knows what has been packaged and how often it is pulled, Smithery knows how often each is actually called, the big community lists know the servers that were never published anywhere, and GitHub knows what was tagged this morning. The same server is in most of them, so the collection deduplicates on URL and the first source to carry a server keeps it.'
)
on conflict (slug) do nothing;

insert into collections (slug, name, description)
values (
  'workflows',
  'Agent workflows',
  'How people actually work with Claude and Claude Code: workflows published and voted on in the r/ClaudeWorkflows library, the skills, subagents, slash commands, hooks and settings the community ships, the plugin marketplaces you can add in one command, and the repositories tagged for them. Rated where the source rates them, and deduplicated across the lists.'
)
on conflict (slug) do nothing;

-- The items first: they are found through the source, so they have to move
-- while the source still says `extensions`.
update items i
   set collection_id = (select id from collections where slug = 'mcp')
  from sources s
 where s.id = i.source_id
   and s.adapter = 'mcp-registry'
   and i.collection_id = (select id from collections where slug = 'extensions');

update sources
   set collection_id = (select id from collections where slug = 'mcp')
 where adapter = 'mcp-registry'
   and collection_id = (select id from collections where slug = 'extensions');

update feeds
   set collection_id = (select id from collections where slug = 'mcp')
 where slug = 'new-mcp-servers'
   and collection_id = (select id from collections where slug = 'extensions');

update collections
   set description = 'New Firefox add-ons and VS Code extensions, with icons, categories and repo stats. MCP servers have a collection of their own.'
 where slug = 'extensions';

-- Both collections are assembled from lists that overlap heavily -- 4,761
-- entries across the four big MCP lists were 4,507 distinct servers, before
-- the registry, Docker, Smithery and GitHub are counted -- so both opt in to
-- dropping an item whose canonical URL another source in the collection
-- already carries. Without this every server would be stored once per list
-- that mentions it.
update collections set dedupe_urls = true where slug in ('mcp', 'workflows');
