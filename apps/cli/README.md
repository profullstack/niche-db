# @profullstack/nichedb

The CLI for a [NicheDB](https://github.com/profullstack/niche-db) deployment, and an MCP server over stdio.

```sh
npm install -g @profullstack/nichedb
nichedb login --api https://nichedb.dev     # paste a key from /settings
nichedb collections
nichedb feeds --collection packages
nichedb items npm-latest --limit 20
nichedb search "mcp server" --collection packages --json
nichedb source add github-releases --name "My repos" --config repos=oven-sh/bun,honojs/hono
nichedb feed create --collection games --name "Free this week" --tags free --upcoming
```

As an MCP server for Claude Code:

```sh
claude mcp add nichedb -- nichedb mcp --api https://nichedb.dev
```

Zero dependencies. Node 22+. `nichedb help` lists every command.
