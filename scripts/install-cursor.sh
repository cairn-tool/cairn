#!/usr/bin/env bash
# Install Cairn's plugin bundles for Cursor on this machine.
#
#   scripts/install-cursor.sh                     all bundles into ~/.cursor/plugins/local
#   scripts/install-cursor.sh cairn-markdown      just one
#   scripts/install-cursor.sh --scope project     merge into the current directory
#
# Cursor auto-scans its local plugin directory, so there is nothing to register.

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

TARGET="cursor"
SCOPE="user"

usage() {
  cat >&2 <<USAGE
Install the Cairn plugin bundles for Cursor.

Usage: scripts/install-cursor.sh [options] [bundle...]

USAGE
  usage_common
  cat >&2 <<USAGE

Destinations:
  user     ~/.cursor/plugins/local/<name>   (auto-scanned, no activation needed)
  project  ./.cursor/ merged into the current directory

Cursor inlines a bundle's skills into its agents; a conversion reports that as an
approximation rather than an error.
USAGE
}

discover_bundles
parse_args "$@"
resolve_cairn
run_per_bundle

if [ "$DRY_RUN" -eq 0 ] && [ "$CHECK" -eq 0 ] && [ "$UNINSTALL" -eq 0 ]; then
  if [ "$SCOPE" = "user" ]; then
    ok "Installed into ${INTO:-~/.cursor/plugins/local}. Restart Cursor to pick them up."
  else
    note "Project scope writes .cursor/ into $PWD."
  fi
fi
