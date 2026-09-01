#!/usr/bin/env bash
# Install Cairn's plugin bundles for Antigravity on this machine.
#
#   scripts/install-antigravity.sh                 all bundles into ~/.gemini/config/plugins
#   scripts/install-antigravity.sh cairn-usage     just one
#   scripts/install-antigravity.sh --scope project merge into the current directory
#
# Discovered plugins are enabled by default, so there is nothing to register.

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

TARGET="antigravity"
SCOPE="user"

usage() {
  cat >&2 <<USAGE
Install the Cairn plugin bundles for Antigravity.

Usage: scripts/install-antigravity.sh [options] [bundle...]

USAGE
  usage_common
  cat >&2 <<USAGE

Destinations:
  user     ~/.gemini/config/plugins/<name>   (discovered and enabled by default)
  project  ./.agents/ merged into the current directory

Antigravity shares ~/.gemini with Gemini CLI. Only the config/plugins subtree is
written here; nothing else under ~/.gemini is touched.
USAGE
}

discover_bundles
parse_args "$@"
resolve_cairn
run_per_bundle

if [ "$DRY_RUN" -eq 0 ] && [ "$CHECK" -eq 0 ] && [ "$UNINSTALL" -eq 0 ]; then
  if [ "$SCOPE" = "user" ]; then
    ok "Installed into ${INTO:-~/.gemini/config/plugins}. Restart Antigravity to pick them up."
  else
    note "Project scope writes .agents/ into $PWD."
  fi
fi
