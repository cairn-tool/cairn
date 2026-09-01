#!/usr/bin/env bash
# Install Cairn's plugin bundles for Claude Code on this machine.
#
#   scripts/install-claude-code.sh                 all bundles, one marketplace, activated
#   scripts/install-claude-code.sh --no-register   write it but leave settings.json alone
#   scripts/install-claude-code.sh cairn-markdown  one bundle, as its own marketplace
#   scripts/install-claude-code.sh --scope project install into the current repository
#
# User scope writes ~/.claude/plugins/marketplaces/ and is the layout Claude Code
# scans. Project scope merges .claude/ into the current directory instead.

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

TARGET="claude-code"
SCOPE="user"
REGISTER=1

usage() {
  cat >&2 <<USAGE
Install the Cairn plugin bundles for Claude Code.

Usage: scripts/install-claude-code.sh [options] [bundle...]

Claude Code specifics:
  --no-register           Write the marketplace but do not edit ~/.claude/settings.json

USAGE
  usage_common
  cat >&2 <<USAGE

Destinations:
  user     ~/.claude/plugins/marketplaces/<name>   (marketplace layout, needs registering)
  project  ./.claude/ merged into the current directory
USAGE
}

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-register) REGISTER=0; shift ;;
    --register) REGISTER=1; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

discover_bundles
parse_args ${ARGS[@]+"${ARGS[@]}"}
resolve_cairn

# Registering is what activates a marketplace install, and only that layout uses
# it. A project-scope merge has no host config to edit.
[ "$SCOPE" = "project" ] && REGISTER=0

# The whole collection under user scope goes in as ONE marketplace, which is what
# `/plugin` shows and what a single `enabledPlugins` block can activate. Naming
# bundles falls back to a per-bundle install, and each of those is a marketplace
# of its own.
if [ "$SCOPE" = "user" ] && [ ${#BUNDLES[@]} -eq ${#ALL_BUNDLES[@]} ] && [ "$UNINSTALL" -eq 0 ]; then
  step "Building and installing the cairn collection -> ~/.claude/plugins/marketplaces/cairn"
  flags=(--install --scope user)
  [ -n "$INTO" ] && flags+=(--into "$INTO")
  [ "$REGISTER" -eq 1 ] && flags+=(--register)
  [ "$LINK" -eq 1 ] && flags+=(--link)
  [ "$FORCE" -eq 1 ] && flags+=(--force)
  [ "$STRICT" -eq 1 ] && flags+=(--strict)
  [ "$DRY_RUN" -eq 1 ] && flags+=(--dry-run)
  [ "$CHECK" -eq 1 ] && flags+=(--check)
  [ -n "$FORMAT" ] && flags+=(--format "$FORMAT")
  flags+=(--target claude-code)
  cairn_run agent marketplace "$MARKETPLACE_SPEC" "${flags[@]}"

  if [ "$REGISTER" -eq 0 ]; then
    note "not registered: add the reported extraKnownMarketplaces and enabledPlugins keys yourself,"
    note "or re-run without --no-register."
  fi
  [ "$DRY_RUN" -eq 0 ] && [ "$CHECK" -eq 0 ] && {
    ok "Installed. Verify with: claude plugin validate ~/.claude/plugins/marketplaces/cairn"
    note "Remove with: scripts/install-claude-code.sh --uninstall"
  }
  exit 0
fi

# Uninstalling the collection is one name, not six: the marketplace is what was
# installed.
if [ "$SCOPE" = "user" ] && [ "$UNINSTALL" -eq 1 ] && [ ${#BUNDLES[@]} -eq ${#ALL_BUNDLES[@]} ]; then
  step "Removing the cairn marketplace from ~/.claude/plugins/marketplaces"
  flags=(--target claude-code --scope user)
  [ -n "$INTO" ] && flags+=(--into "$INTO")
  [ "$DRY_RUN" -eq 1 ] && flags+=(--dry-run)
  [ "$CHECK" -eq 1 ] && flags+=(--check)
  [ -n "$FORMAT" ] && flags+=(--format "$FORMAT")
  cairn_run agent uninstall cairn "${flags[@]}"
  exit 0
fi

if [ "$SCOPE" = "user" ] && [ "$UNINSTALL" -eq 0 ]; then
  warn "installing named bundles one at a time: each becomes its own marketplace under"
  warn "~/.claude/plugins/marketplaces/. Omit the names to install the single cairn collection."
  # Each of those is a marketplace layout, so each needs its own activation edit.
  [ "$REGISTER" -eq 1 ] && EXTRA_INSTALL_FLAGS+=(--register)
fi

run_per_bundle

[ "$SCOPE" = "project" ] && [ "$DRY_RUN" -eq 0 ] && [ "$CHECK" -eq 0 ] &&
  note "Project scope writes .claude/ (and .mcp.json) into $PWD."
exit 0
