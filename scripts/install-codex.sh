#!/usr/bin/env bash
# Install Cairn's plugin bundles for Codex, into a project on this machine.
#
#   scripts/install-codex.sh                    into the current directory
#   scripts/install-codex.sh --into ~/src/app   into another repository
#   scripts/install-codex.sh cairn-markdown     just one bundle
#
# Codex has no user-scope destination. Its rules root is AGENTS.md, and a
# user-scope merge would clobber ~/AGENTS.md, so the target profile records no
# user location and `agent install --scope user` reports AB800. Project scope is
# the only install for this host.

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

TARGET="codex"
SCOPE="project"

usage() {
  cat >&2 <<USAGE
Install the Cairn plugin bundles for Codex, into a project directory.

Usage: scripts/install-codex.sh [options] [bundle...]

USAGE
  usage_common
  cat >&2 <<USAGE

Destination:
  project  .codex/, .agents/ and assets/ merged into --into (default: the current
           directory), plus AGENTS.md for a bundle carrying rules

There is no user scope: Codex's user-scope rules root is ~/AGENTS.md, which an
install would clobber, so the target profile declares no location for it.

Every Codex conversion carries approximate diagnostics — Codex has no separate
skill or hook surface for some of what a bundle declares. That is expected and
does not fail the install; --strict makes it fail.
USAGE
}

discover_bundles
parse_args "$@"

if [ "$SCOPE" != "project" ]; then
  die "codex has no $SCOPE-scope destination; install into a project with --into <dir>"
fi

resolve_cairn

DEST="${INTO:-$PWD}"
step "Destination: $DEST"

run_per_bundle

if [ "$DRY_RUN" -eq 0 ] && [ "$CHECK" -eq 0 ] && [ "$UNINSTALL" -eq 0 ]; then
  ok "Installed into $DEST (.codex/, .agents/, assets/)."
  note "Remove with: scripts/install-codex.sh --uninstall${INTO:+ --into \"$INTO\"}"
fi
