# MCP servers and agent workflows

Seven collections built from the same problem: everything worth knowing about
MCP servers and about how people work with coding agents is written down in
somebody's list, and there are a dozen lists, and they overlap. Nobody
maintains the union. These collections are the union, cleaned.

| Collection | Where | Distinct rows, first pass |
| --- | --- | --- |
| MCP servers | `/c/mcp` | 5,782 |
| Agent workflows | `/workflows` | 1,309 |
| Skills | `/skills` | 894 |
| Subagents | `/agents` | 587 |
| Slash commands | `/commands` | 288 |
| Plugins | `/plugins` | 117 |
| Hooks | `/hooks` | 62 |

A subagent, a skill, a slash command, a hook and a plugin are five different
things to go looking for, so they are five collections rather than five kinds
inside one. Each is also a name at the site root, because a collection seeds a
niche and a niche's page is served from `/`. **MCP is the exception**: `mcp` is
a reserved niche slug — `/mcp` is this site's own MCP endpoint — so the servers
live at `/c/mcp` and nowhere else.

`workflows` keeps what is read rather than installed: the library posts, the
guides and CLAUDE.md files, settings bundles, agent loops, behaviour mods, and
the repositories tagged for all of it.

## Where the rows come from

### `/c/mcp`

| Source | Slug | Rows measured 2026-09-25 | What only it knows | Cadence |
| --- | --- | --- | --- | --- |
| Official MCP registry | `mcp-servers` | 181 servers from 300 published versions | what was published, by whom, with which packages and remote endpoints, and its status | 30 min |
| Docker MCP catalogue | `docker-mcp-catalog` | 270 entries, 237 servers | what has been packaged as an image: pull counts, category, licence, and the tools each server exposes | 12 h |
| Smithery registry | `smithery-servers` | 512 a run, 17,195 claimed | how often a server is actually called, and whether it is deployed right now | 3 h |
| punkpeye list | `awesome-mcp-punkpeye` | 4,273 | the long tail nobody published anywhere | 6 h |
| wong2 list | `awesome-mcp-wong2` | 260 | a curated shortlist, official servers marked | 6 h |
| appcypher list | `awesome-mcp-appcypher` | 188 | another curation, different bias | 6 h |
| Protocol repo README | `awesome-mcp-reference` | 20 | the reference servers and what has been archived | 6 h |
| aitmpl MCP configs | `aitmpl-mcps` | 104 | a ready-made config and an install count | 12 h |
| GitHub topic search | `github-mcp-topics` | 400 a run, 30,246 matched | what was tagged this morning | 1 h |

### `/workflows` and the four beside it

| Source | Slug | Collection | Rows | What only it knows |
| --- | --- | --- | --- | --- |
| r/ClaudeWorkflows | `reddit-claude-workflows` | workflows | 600 a run, walking from 2026-05 | a workflow written out by the person who used it, rated by votes, with a template the adapter parses into fields |
| awesome-claude-code | `awesome-claude-code` | workflows | 197 | a maintainer who re-checks links and marks the dead ones |
| aitmpl settings, loops, mods | `aitmpl-components` | workflows | 119 | ways of working rather than things installed |
| GitHub topic search | `github-agent-topics` | workflows | 398 a run, 77,213 matched | repositories tagged before any list has them |
| aitmpl skills | `aitmpl-skills` | skills | 889 | the bulk catalogue, with install counts |
| awesome-claude-code skills | `awesome-claude-code-skills` | skills | 5 | the hand-picked few |
| aitmpl subagents | `aitmpl-agents` | agents | 422 | subagents by category, with install counts |
| VoltAgent list | `awesome-subagents-voltagent` | agents | 165 | each subagent named, rather than the bundle it ships in |
| aitmpl commands | `aitmpl-commands` | commands | 288 | slash commands with install counts |
| aitmpl hooks | `aitmpl-hooks` | hooks | 62 | what runs before and after a tool call, a prompt or a session |
| Plugin marketplaces | `claude-plugin-marketplaces` | plugins | 117 across 3 manifests | what a marketplace installs, declared by its publisher for machines to read |

Everything is keyless. `GITHUB_TOKEN` is optional and only raises rate limits:
search goes from 10 requests a minute to 30, and the `github-repo` enricher
from 60 an hour to 5,000.

Reddit is read through the Arctic Shift archive rather than reddit.com, which
blocks this deployment on every road including a real browser. See
`packages/adapters/src/redditworkflows.js`.

**One file, several adapters.** aitmpl's `components.json` feeds six
collections and awesome-claude-code's CSV feeds two, because an adapter writes
into exactly one collection. That is deliberate rather than reluctant: a source
is what a reader follows and what the run log reports on, so "subagents from
aitmpl" and "skills from aitmpl" should be two rows on the sources page. The
cost is re-fetching one file per collection, which is why those cadences are
slow and staggered.

## Deduplication

Every one of these collections has `dedupe_urls` set, so the core drops an item
whose canonical URL another source in the same collection already carries. That
is only useful if the URLs are comparable in the first place, which they are not
as published: the same server is written `https://github.com/Owner/Repo`,
`.../owner/repo/`, `.../owner/repo.git`, `.../owner/repo/blob/main/src/x` and
`.../owner/repo/tree/9f8c1ab/src/x`.

`repoUrl` in `packages/adapters/src/catalogs.js` folds those: owner and repo
lowercased (GitHub is case insensitive), `.git` and trailing slashes dropped,
`blob` and `tree` unified, and any ref replaced with `HEAD` so a pinned sha
agrees with `main`. What it deliberately does not do is drop the subpath —
`modelcontextprotocol/servers` holds seven servers under `src/` and
`awslabs/mcp` a dozen, and collapsing those to the repository root would fuse
distinct servers into one row. Measured: 4,761 entries across the four MCP
lists are 4,507 distinct servers, and 82 of Docker's 270 entries share a
repository with another.

**First writer keeps the row**, so the order sources are registered in
(`packages/adapters/src/index.js`) is the order in which a duplicate's account
of itself is decided: published beats packaged beats measured beats curated
beats tagged.

Two traps this collection walked into, both fixed in the adapters rather than
in the deduplication:

- The official registry lists every published **version** as its own entry, and
  some publishers name a repository that is not theirs — three
  `agency.ottobot/*` servers point at `modelcontextprotocol/registry` itself.
  Left alone, 300 entries deduplicated to 174 and 126 published servers
  vanished. `collapse` keeps one row per server at its newest version, and a
  URL claimed by more than one server name identifies none of them, so those
  fall back to their own registry page.
- aitmpl's 14 project templates are the only components with no path, so all 14
  linked to the same directory. They are not ingested.

## What a row carries

Beyond the usual title, summary, URL and tags:

- **MCP**: `repo`, the packages and remote endpoints, registry `status`,
  Docker's `pulls`/`tools`/`license`/`category`, Smithery's `useCount` and
  whether it is deployed and verified, and for a tagged repository its stars,
  language and last push.
- **A library post**: `value`, `freshness`, `confidence`, `status`, `level`,
  `categories` and the original source it was lifted from, plus the vote count.
- **A component or plugin**: the install count and the exact command that
  installs it (`npx claude-code-templates@latest --agent …`, or
  `/plugin marketplace add owner/repo`).

The `github-repo` enricher is on by default for all seven, so a row whose URL is
a repository gains stars, licence, language, topics, last push and whether the
repository has been archived — which is how a dead server shows up as dead
without anyone re-checking a list by hand.

## Feeds

`/c/mcp/new-mcp-servers`, `/c/mcp/mcp-remote-servers`,
`/c/mcp/mcp-packaged-servers`, then one per collection beside them:
`claude-workflows` and `workflow-library` under workflows, and `new-skills`,
`new-subagents`, `new-slash-commands`, `new-plugins` and `new-hooks`.

`new-mcp-servers` kept its slug through the move out of `/c/extensions`
(migration `0032`), because a feed URL is a promise to whoever is polling it.

Migration `0033` is what split the five component collections out of
`workflows`, as a second migration rather than an edit to `0032`: migrations
are keyed by filename with no checksum, so editing one that has already run
means it never runs again -- the collections would still appear, because
seeding creates them, but with `dedupe_urls` silently false.
