-- The four things people install get collections of their own, beside the
-- workflows they are used in.
--
-- 0032 put MCP servers in `mcp` and everything else about working with an
-- agent in `workflows`. That second collection was one box holding five
-- different questions: a subagent, a skill, a slash command, a hook and a
-- plugin are not variants of each other, and nobody looking for a hook wants
-- to page through 889 skills to find one.
--
-- So they become collections. Each is also a name, because a collection seeds
-- a niche and a niche's page is served from the site root: /skills, /agents,
-- /commands, /plugins, /hooks, beside /workflows. None of those five is a
-- reserved slug, so none of them is shadowed by a real route.
--
-- `mcp` is the exception and keeps only /c/mcp: that slug IS reserved, because
-- /mcp is this site's own MCP endpoint.
--
-- WHY THIS IS NOT AN EDIT TO 0032
--
-- 0032 has already run. Migrations are keyed by filename with no checksum, so
-- an edited one is never applied again: the five collections would still have
-- appeared, because seeding creates them, but with `dedupe_urls` silently
-- false -- and nothing else ever turns it on. A skill would then be stored
-- once per list that carries it, quietly, forever.

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

-- Each of these is assembled from lists that overlap, so each opts in to
-- dropping an item whose canonical URL another source in the same collection
-- already carries. This is the statement that could not wait for a seed.
update collections
   set dedupe_urls = true
 where slug in ('skills', 'agents', 'commands', 'plugins', 'hooks');

-- And `workflows` stops describing the four collections it no longer holds.
update collections
   set description = 'How people actually work with Claude and Claude Code: workflows published and voted on in the r/ClaudeWorkflows library, the guides and CLAUDE.md files the community keeps, settings bundles, agent loops and behaviour mods, and the repositories tagged for all of it. Rated where the source rates them, and deduplicated across the lists. The things you install rather than read have collections of their own: skills, subagents, commands, hooks and plugins.'
 where slug = 'workflows';

-- The plugin marketplaces move wholesale, source and items together, the way
-- the NWS alerts moved in 0010: every row that source writes is a plugin, it
-- keeps its slug, its cursor and its run history, and leaving it where it is
-- would have the next boot seed a SECOND copy under `plugins` with both
-- polling the same manifests forever.
update items i
   set collection_id = (select id from collections where slug = 'plugins')
  from sources s
 where s.id = i.source_id
   and s.adapter = 'plugin-marketplaces'
   and i.collection_id = (select id from collections where slug = 'workflows');

update sources
   set collection_id = (select id from collections where slug = 'plugins')
 where adapter = 'plugin-marketplaces'
   and collection_id = (select id from collections where slug = 'workflows');

/*
 * The skills, subagents, commands and hooks `aitmpl-components` wrote before
 * it was split are dropped rather than moved.
 *
 * Moving them looks kinder and is worse. An item's collection comes from its
 * SOURCE's collection, and that source stays in `workflows` -- it still
 * carries settings, loops and mods. A moved row would sit in `skills` owned by
 * a `workflows` source, and because the collection deduplicates on URL it
 * would then block the real `aitmpl-skills` source from ever writing the row
 * it is there to write. So they go, and the new sources re-ingest them from
 * the same 2 MB file within hours of the deploy.
 *
 * Narrow on purpose: only that one adapter's rows, only the kinds that left,
 * only from `workflows`. Nothing else in the collection matches, and on a
 * database where 0032 never ran long enough to ingest anything this deletes
 * nothing at all.
 */
delete from items i
 using sources s
 where s.id = i.source_id
   and s.adapter = 'aitmpl-components'
   and i.kind in ('skill', 'agent', 'command', 'hook')
   and i.collection_id = (select id from collections where slug = 'workflows');

-- Same for the awesome-claude-code skills, which now arrive through a source
-- of their own pointed at `skills`.
delete from items i
 using sources s
 where s.id = i.source_id
   and s.adapter = 'awesome-claude-code'
   and i.kind = 'skill'
   and i.collection_id = (select id from collections where slug = 'workflows');

-- The feeds 0032 seeded for kinds that have left, so a collection page does
-- not offer a filter that can never match again. Their replacements, one per
-- new collection, are seeded on the next boot.
delete from feeds
 where slug in (
   'claude-skills',
   'claude-subagents',
   'claude-commands',
   'claude-plugins',
   'claude-hooks'
 )
   and collection_id = (select id from collections where slug = 'workflows');
