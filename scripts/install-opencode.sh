#!/usr/bin/env bash
# Install Cairn's plugin bundles for OpenCode, into a project on this machine.
#
#   scripts/install-opencode.sh                    into the current directory
#   scripts/install-opencode.sh --into ~/src/app   into another repository
#   scripts/install-opencode.sh cairn-jira         just one bundle
#
# OpenCode has no user-scope destination. Global scope drops the `.opencode/`
# prefix — skills live at ~/.config/opencode/skills, not
# ~/.config/opencode/.opencode/skills — and an install location cannot rewrite a
# path, so the target profile records no user location and `--scope user` reports
# AB800. Project scope is the only install for this host.

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

TARGET="opencode"
SCOPE="project"

usage() {
  cat >&2 <<USAGE
Install the Cairn plugin bundles for OpenCode, into a project directory.

Usage: scripts/install-opencode.sh [options] [bundle...]

USAGE
  usage_common
  cat >&2 <<USAGE

Destination:
  project  .opencode/, opencode.json and assets/ merged into --into (default: the
           current directory)

There is no user scope: OpenCode's global layout drops the .opencode/ prefix, and
an install location cannot rewrite a path, so the target profile declares no
location for it.
USAGE
}

discover_bundles
parse_args "$@"

if [ "$SCOPE" != "project" ]; then
  die "opencode has no $SCOPE-scope destination; install into a project with --into <dir>"
fi

resolve_cairn

DEST="${INTO:-$PWD}"
step "Destination: $DEST"

run_per_bundle

if [ "$DRY_RUN" -eq 0 ] && [ "$CHECK" -eq 0 ] && [ "$UNINSTALL" -eq 0 ]; then
  ok "Installed into $DEST (.opencode/, opencode.json, assets/)."
  note "Remove with: scripts/install-opencode.sh --uninstall${INTO:+ --into \"$INTO\"}"
fi
