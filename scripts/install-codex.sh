#!/usr/bin/env bash
# Install Cairn's plugin bundles for Codex on this machine.
#
#   scripts/install-codex.sh                 all bundles, one marketplace, installed and enabled
#   scripts/install-codex.sh --no-register   write it without invoking the Codex plugin CLI
#   scripts/install-codex.sh cairn-markdown  one bundle, as its own marketplace
#   scripts/install-codex.sh --scope project install into the current repository
#
# User scope writes under $CODEX_HOME/marketplaces (or ~/.codex/marketplaces)
# and registers that local marketplace through Codex. Project scope retains the
# direct .codex/.agents merge used before user-scoped plugin installs existed.

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

TARGET="codex"
SCOPE="user"
REGISTER=1

usage() {
  cat >&2 <<USAGE
Install the Cairn plugin bundles for Codex.

Usage: scripts/install-codex.sh [options] [bundle...]

Codex specifics:
  --no-register           Write the marketplace but do not invoke the Codex plugin CLI

USAGE
  usage_common
  cat >&2 <<USAGE

Destinations:
  user     \$CODEX_HOME/marketplaces/<name> (fallback ~/.codex/marketplaces),
           then registered, installed, and enabled through codex plugin
  project  .codex/, .agents/ and assets/ merged into --into (default: current directory)
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

# Project scope is a direct merge and has no marketplace registration step.
[ "$SCOPE" = "project" ] && REGISTER=0

codex_root="${CODEX_HOME:-$HOME/.codex}/marketplaces"

# The complete user install is one collection so Codex presents one marketplace
# with independently installed plugins. Naming bundles intentionally falls back
# to one local marketplace per bundle.
if [ "$SCOPE" = "user" ] && [ ${#BUNDLES[@]} -eq ${#ALL_BUNDLES[@]} ] && [ "$UNINSTALL" -eq 0 ]; then
  step "Building and installing the cairn collection -> $codex_root/cairn"
  flags=(--install --scope user --target codex)
  [ -n "$INTO" ] && flags+=(--into "$INTO")
  [ "$REGISTER" -eq 1 ] && flags+=(--register)
  [ "$LINK" -eq 1 ] && flags+=(--link)
  [ "$FORCE" -eq 1 ] && flags+=(--force)
  [ "$STRICT" -eq 1 ] && flags+=(--strict)
  [ "$DRY_RUN" -eq 1 ] && flags+=(--dry-run)
  [ "$CHECK" -eq 1 ] && flags+=(--check)
  [ -n "$FORMAT" ] && flags+=(--format "$FORMAT")
  cairn_run agent marketplace "$MARKETPLACE_SPEC" "${flags[@]}"

  if [ "$REGISTER" -eq 0 ]; then
    note "not registered: run the Codex commands reported as AB805 yourself,"
    note "or re-run without --no-register."
  fi
  if [ "$DRY_RUN" -eq 0 ] && [ "$CHECK" -eq 0 ]; then
    if [ "$REGISTER" -eq 1 ]; then
      ok "Installed and enabled. Verify with: codex plugin list --marketplace cairn"
    else
      ok "Marketplace written to $codex_root/cairn."
    fi
    note "Remove with: scripts/install-codex.sh --uninstall"
  fi
  exit 0
fi

# The complete user collection is recorded under its marketplace name.
if [ "$SCOPE" = "user" ] && [ "$UNINSTALL" -eq 1 ] && [ ${#BUNDLES[@]} -eq ${#ALL_BUNDLES[@]} ]; then
  step "Removing the cairn marketplace from $codex_root"
  flags=(--target codex --scope user)
  [ -n "$INTO" ] && flags+=(--into "$INTO")
  [ "$DRY_RUN" -eq 1 ] && flags+=(--dry-run)
  [ "$CHECK" -eq 1 ] && flags+=(--check)
  [ -n "$FORMAT" ] && flags+=(--format "$FORMAT")
  cairn_run agent uninstall cairn "${flags[@]}"
  exit 0
fi

if [ "$SCOPE" = "user" ] && [ "$UNINSTALL" -eq 0 ]; then
  warn "installing named bundles one at a time: each becomes its own marketplace under"
  warn "$codex_root/. Omit the names to install the single cairn collection."
  [ "$REGISTER" -eq 1 ] && EXTRA_INSTALL_FLAGS+=(--register)
fi

run_per_bundle

[ "$SCOPE" = "project" ] && [ "$DRY_RUN" -eq 0 ] && [ "$CHECK" -eq 0 ] &&
  note "Project scope writes .codex/, .agents/, assets/, and possibly AGENTS.md into ${INTO:-$PWD}."
exit 0
