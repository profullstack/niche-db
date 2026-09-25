-- Seven collections for MCP servers and for how people work with agents, and
-- the MCP servers move out of `extensions`.
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
  'How people actually work with Claude and Claude Code: workflows published and voted on in the r/ClaudeWorkflows library, the guides and CLAUDE.md files the community keeps, settings bundles, agent loops and behaviour mods, and the repositories tagged for all of it. Rated where the source rates them, and deduplicated across the lists. The things you install rather than read have collections of their own: skills, subagents, commands, hooks and plugins.'
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

-- The four things people install get collections of their own, beside the
-- workflows they are used in.
--
-- A subagent, a skill, a slash command, a hook and a plugin are five different
-- things to go looking for, and a niche's page is served from the site root,
-- so each of these is also a name: /skills, /agents, /commands, /plugins,
-- /hooks. `mcp` deliberately has no collection of its own here because that
-- slug is reserved -- /mcp is this site's own MCP endpoint -- so the servers
-- stay at /c/mcp.

insert into collections (slug, name, description)
values
  (
    'skills',
    'Skills',
    'Agent skills you can drop into a project: the 890 claude-code-templates ships with their install counts, and the hand-picked ones from awesome-claude-code. One row per skill, with the command that installs it.'
  ),
  (
    'agents',
    'Subagents',
    'Subagents by the job they do, from the claude-code-templates catalogue and the community lists that name each one rather than the bundle it ships in. One row per subagent, with its category and the file that defines it.'
  ),
  (
    'commands',
    'Slash commands',
    'Slash commands the community ships, by category, with how many times each has been installed and the one line that installs it.'
  ),
  (
    'plugins',
    'Plugins',
    'Every plugin declared in a Claude Code marketplace manifest, the official one included: what it installs, who wrote it, its version and licence, and the command that adds the marketplace it comes from.'
  ),
  (
    'hooks',
    'Hooks',
    'Hooks: what runs before and after a tool call, a prompt or a session. The ones the community ships, with install counts.'
  )
on conflict (slug) do nothing;

-- Every one of these is assembled from lists that overlap -- 4,761 entries
-- across the four big MCP lists were 4,507 distinct servers, before the
-- registry, Docker, Smithery and GitHub are counted -- so they all opt in to
-- dropping an item whose canonical URL another source in the same collection
-- already carries. Without this a server would be stored once per list that
-- mentions it.
update collections
   set dedupe_urls = true
 where slug in ('mcp', 'workflows', 'skills', 'agents', 'commands', 'plugins', 'hooks');
