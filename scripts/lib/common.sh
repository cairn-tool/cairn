#!/usr/bin/env bash
# Shared helpers for the per-target install scripts in this directory.
#
# Sourced, never executed. Every script here resolves the same cairn binary,
# discovers the same bundle list, and parses the same flags, so the only thing a
# per-target script owns is the destination its host actually scans.

set -euo pipefail

# --- output ------------------------------------------------------------------

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_DIM=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_OFF=""
fi

info() { printf '%s\n' "$*" >&2; }
step() { printf '%s==>%s %s\n' "$C_BOLD" "$C_OFF" "$*" >&2; }
note() { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF" >&2; }
warn() { printf '%swarning:%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
ok()   { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_OFF" >&2; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# --- locations ---------------------------------------------------------------

SCRIPTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd -- "$SCRIPTS_DIR/.." && pwd)"
MARKETPLACE_SPEC="$REPO_ROOT/agent-marketplace.yaml"

# --- the cairn binary --------------------------------------------------------

# Prefer this checkout's own build: the bundles under plugins/ are this
# checkout's, and a globally installed cairn may predate a manifest key they
# use. CAIRN_BIN overrides; CAIRN_NO_BUILD=1 falls back to PATH rather than
# building.
CAIRN=()

resolve_cairn() {
  if [ -n "${CAIRN_BIN:-}" ]; then
    # shellcheck disable=SC2206  # deliberate word splitting: CAIRN_BIN may carry arguments
    CAIRN=($CAIRN_BIN)
    note "using CAIRN_BIN: ${CAIRN[*]}"
    return
  fi

  local dist="$REPO_ROOT/dist/cli.js"
  if [ ! -f "$dist" ] && [ -z "${CAIRN_NO_BUILD:-}" ]; then
    if [ ! -d "$REPO_ROOT/node_modules" ]; then
      step "Installing dependencies (node_modules is missing)"
      (cd "$REPO_ROOT" && npm ci) || die "npm ci failed"
    fi
    step "Building the CLI (dist/cli.js is missing)"
    (cd "$REPO_ROOT" && npm run --silent build) || die "npm run build failed"
  fi

  if [ -f "$dist" ]; then
    CAIRN=(node "$dist")
    note "using $dist"
  elif command -v cairn >/dev/null 2>&1; then
    CAIRN=(cairn)
    note "using $(command -v cairn)"
  else
    die "no cairn found: build this checkout (npm run build), install @cairn-tool/cairn globally, or set CAIRN_BIN"
  fi
}

cairn_run() {
  note "\$ ${CAIRN[*]} $*"
  "${CAIRN[@]}" "$@"
}

# --- bundles -----------------------------------------------------------------

# Every bundle under plugins/, in the order agent-marketplace.yaml declares them
# — the spec is the record of what this repository publishes, so a bundle that is
# present but undeclared is not installed by these scripts either.
ALL_BUNDLES=()

discover_bundles() {
  [ -f "$MARKETPLACE_SPEC" ] || die "missing $MARKETPLACE_SPEC"
  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    [ -f "$REPO_ROOT/$path/agent-bundle.yaml" ] ||
      die "$MARKETPLACE_SPEC declares $path, which has no agent-bundle.yaml"
    ALL_BUNDLES+=("$(basename "$path")")
  done < <(sed -n 's/^[[:space:]]*-[[:space:]]*path:[[:space:]]*\(.*\)$/\1/p' "$MARKETPLACE_SPEC")

  [ ${#ALL_BUNDLES[@]} -gt 0 ] || die "no bundles declared in $MARKETPLACE_SPEC"
}

bundle_path() { printf '%s\n' "$REPO_ROOT/plugins/$1"; }

# --- flags -------------------------------------------------------------------

TARGET=""          # set by the caller before parse_args
SCOPE=""           # set by the caller as the default for its target
INTO=""
DRY_RUN=0
CHECK=0
LINK=0
FORCE=0
STRICT=0
UNINSTALL=0
FORMAT=""
BUNDLES=()
# Per-target flags a script adds to every install it issues (e.g. --register).
EXTRA_INSTALL_FLAGS=()

usage_common() {
  cat >&2 <<USAGE
Options:
  --scope <user|project>  Install scope (default: $SCOPE)
  --into <dir>            Install root override (default: the target profile's)
  --link                  Symlink the rendered tree instead of copying it
  --force                 Replace a destination this bundle does not own
  --strict                Treat warnings as blocking
  -n, --dry-run           Plan the install without writing
  --check                 Compare against an existing install without writing
  --uninstall             Remove a previous install instead of writing one
  --format <fmt>          Pass --format through to cairn (llm, human, json)
  -h, --help              Show this help

Arguments:
  [bundle...]             Bundle names to install (default: all of them)

Environment:
  CAIRN_BIN               Override the cairn invocation (e.g. "cairn")
  CAIRN_NO_BUILD=1        Never run npm run build; fall back to cairn on PATH
USAGE
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --scope) SCOPE="${2:-}"; [ -n "$SCOPE" ] || die "--scope needs a value"; shift 2 ;;
      --scope=*) SCOPE="${1#*=}"; shift ;;
      --into) INTO="${2:-}"; [ -n "$INTO" ] || die "--into needs a value"; shift 2 ;;
      --into=*) INTO="${1#*=}"; shift ;;
      --format) FORMAT="${2:-}"; [ -n "$FORMAT" ] || die "--format needs a value"; shift 2 ;;
      --format=*) FORMAT="${1#*=}"; shift ;;
      --link) LINK=1; shift ;;
      --force) FORCE=1; shift ;;
      --strict) STRICT=1; shift ;;
      -n|--dry-run) DRY_RUN=1; shift ;;
      --check) CHECK=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      -h|--help) usage; exit 0 ;;
      -*) die "unknown option: $1 (try --help)" ;;
      *) BUNDLES+=("$1"); shift ;;
    esac
  done

  case "$SCOPE" in
    user|project) ;;
    *) die "--scope must be user or project, got '$SCOPE'" ;;
  esac

  [ "$DRY_RUN" -eq 1 ] && [ "$CHECK" -eq 1 ] &&
    die "--dry-run and --check cannot be combined"

  if [ ${#BUNDLES[@]} -eq 0 ]; then
    BUNDLES=("${ALL_BUNDLES[@]}")
  else
    local name found
    for name in "${BUNDLES[@]}"; do
      found=0
      local known
      for known in "${ALL_BUNDLES[@]}"; do
        [ "$name" = "$known" ] && found=1 && break
      done
      [ "$found" -eq 1 ] || die "unknown bundle '$name' (known: ${ALL_BUNDLES[*]})"
    done
  fi
}

# Flags shared by every `cairn agent install` this directory issues.
install_flags() {
  local flags=(--target "$TARGET" --scope "$SCOPE")
  [ -n "$INTO" ] && flags+=(--into "$INTO")
  [ "$LINK" -eq 1 ] && flags+=(--link)
  [ "$FORCE" -eq 1 ] && flags+=(--force)
  [ "$STRICT" -eq 1 ] && flags+=(--strict)
  [ "$DRY_RUN" -eq 1 ] && flags+=(--dry-run)
  [ "$CHECK" -eq 1 ] && flags+=(--check)
  [ -n "$FORMAT" ] && flags+=(--format "$FORMAT")
  [ ${#EXTRA_INSTALL_FLAGS[@]} -gt 0 ] && flags+=("${EXTRA_INSTALL_FLAGS[@]}")
  printf '%s\n' "${flags[@]}"
}

uninstall_flags() {
  local flags=(--target "$TARGET" --scope "$SCOPE")
  [ -n "$INTO" ] && flags+=(--into "$INTO")
  [ "$DRY_RUN" -eq 1 ] && flags+=(--dry-run)
  [ "$CHECK" -eq 1 ] && flags+=(--check)
  [ -n "$FORMAT" ] && flags+=(--format "$FORMAT")
  printf '%s\n' "${flags[@]}"
}

# Install (or uninstall) each selected bundle one at a time. A per-bundle run
# means one failing bundle does not silently drop the rest — cairn plans a run in
# full before writing, so a combined run that blocks writes nothing at all.
run_per_bundle() {
  local failed=() name flags=()
  local action="install"
  [ "$UNINSTALL" -eq 1 ] && action="uninstall"

  for name in "${BUNDLES[@]}"; do
    step "$action $name -> $TARGET ($SCOPE${INTO:+, into $INTO})"
    if [ "$UNINSTALL" -eq 1 ]; then
      while IFS= read -r line; do flags+=("$line"); done < <(uninstall_flags)
      cairn_run agent uninstall "$name" "${flags[@]}" || failed+=("$name")
    else
      while IFS= read -r line; do flags+=("$line"); done < <(install_flags)
      cairn_run agent install "$(bundle_path "$name")" "${flags[@]}" || failed+=("$name")
    fi
    flags=()
  done

  if [ ${#failed[@]} -gt 0 ]; then
    die "${#failed[@]} bundle(s) failed: ${failed[*]}"
  fi
}
