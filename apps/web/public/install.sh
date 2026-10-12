#!/bin/sh
# Install the nichedb CLI and stdio MCP server (npm: @profullstack/nichedb).
#
#   curl -fsSL https://nichedb.dev/install.sh | sh
#
# Uses bun if present, otherwise npm (Node >= 22). When the global npm prefix
# is not writable it installs into ~/.local instead of asking for sudo.
# Re-running it upgrades to the latest release.
set -eu

PKG="@profullstack/nichedb"
BIN="nichedb"

say() { printf '%s\n' "$*"; }
die() { printf 'nichedb install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

say "Installing nichedb (NicheDB CLI + MCP server)..."

if have bun; then
  bun add -g "$PKG@latest"
  BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
elif have npm && have node; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 22 ] || die "Node >= 22 required (found $(node -v)). Upgrade Node or install bun: https://bun.sh"
  prefix=$(npm config get prefix)
  modules="$prefix/lib/node_modules"
  [ -d "$modules" ] || modules="$prefix/lib"
  if [ -w "$modules" ] && [ -w "$prefix/bin" ]; then
    npm install -g "$PKG@latest"
    BIN_DIR="$prefix/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    say "npm prefix $prefix is not writable; installing into $HOME/.local"
    npm install -g --prefix "$HOME/.local" "$PKG@latest"
  fi
else
  die "needs bun (https://bun.sh) or Node >= 22 with npm (https://nodejs.org)"
fi

say ""
if have "$BIN"; then
  say "nichedb $("$BIN" version 2>/dev/null || echo '') installed."
else
  say "nichedb installed to $BIN_DIR, which is not on your PATH. Add it:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
fi
say ""
say "Next:"
say "  nichedb login --api https://nichedb.dev   # paste a key from /settings"
say "  nichedb collections                       # reads need no key"
say "  nichedb search \"mcp server\" --json"
say "  claude mcp add nichedb -- nichedb mcp --api https://nichedb.dev"
say "  nichedb help                              # every command"
