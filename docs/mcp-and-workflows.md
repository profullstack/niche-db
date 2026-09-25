# MCP servers (`/c/mcp`) and agent workflows (`/c/workflows`)

Two collections built from the same problem: everything worth knowing about
MCP servers and about how people work with coding agents is written down in
somebody's list, and there are a dozen lists, and they overlap. Nobody
maintains the union. These collections are the union, cleaned.

They ship together because they share their machinery — the same URL folding,
the same deduplication, two sources that feed both — and because the question
that started them ("which MCP server does this?") and the question beside it
("how do people actually use it?") are asked by the same person on the same
afternoon.

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

### `/c/workflows`

| Source | Slug | Rows measured 2026-09-25 | What only it knows | Cadence |
| --- | --- | --- | --- | --- |
| r/ClaudeWorkflows | `reddit-claude-workflows` | 600 posts a run, walking from 2026-05 | a workflow written out by the person who used it, rated by votes, with a template the adapter parses into fields | 1 h |
| awesome-claude-code | `awesome-claude-code` | 202 live of 212 | a maintainer who re-checks links and marks the dead ones | 6 h |
| Plugin marketplaces | `claude-plugin-marketplaces` | 117 plugins across 3 manifests | what a marketplace installs, declared by its publisher for machines to read | 4 h |
| aitmpl components | `aitmpl-components` | 1,780 | skills, subagents, commands, hooks, settings, loops and mods with install counts | 8 h |
| GitHub topic search | `github-agent-topics` | 399 a run, 77,213 matched | repositories tagged for Claude Code before any list has them | 1 h |

Everything is keyless. `GITHUB_TOKEN` is optional and only raises rate limits:
search goes from 10 requests a minute to 30, and the `github-repo` enricher
from 60 an hour to 5,000.

Reddit is read through the Arctic Shift archive rather than reddit.com, which
blocks this deployment on every road including a real browser. See
`packages/adapters/src/redditworkflows.js`.

## Deduplication

Both collections have `dedupe_urls` set, so the core drops an item whose
canonical URL another source in the collection already carries. That is only
useful if the URLs are comparable in the first place, which they are not as
published: the same server is written `https://github.com/Owner/Repo`,
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
repository with another entry.

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
- **Workflows**: for a library post, `value`, `freshness`, `confidence`,
  `status`, `level`, `categories` and the original source it was lifted from,
  plus the vote count; for a component or plugin, the install count and the
  exact command that installs it.

The `github-repo` enricher is on by default for both, so a row whose URL is a
repository gains stars, licence, language, topics, last push and whether the
repository has been archived — which is how a dead server shows up as dead
without anyone re-checking a list by hand.

## Feeds

`/c/mcp/new-mcp-servers`, `/c/mcp/mcp-remote-servers`,
`/c/mcp/mcp-packaged-servers`, and for workflows `claude-workflows`,
`claude-skills`, `claude-subagents`, `claude-commands`, `claude-plugins` and
`claude-hooks`.

`new-mcp-servers` kept its slug through the move out of `/c/extensions`
(migration `0032`), because a feed URL is a promise to whoever is polling it.
