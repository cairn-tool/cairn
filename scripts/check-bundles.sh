#!/usr/bin/env bash
# Validate, convert, doctor, test, and audit every bundle under plugins/, for
# every target — the check `.github/workflows/ci.yml` runs, runnable locally.
#
#   scripts/check-bundles.sh                       all targets, all bundles
#   scripts/check-bundles.sh cursor opencode       just those hosts
#   scripts/check-bundles.sh --strict              require zero findings everywhere
#   scripts/check-bundles.sh --bundle cairn-jira   one bundle, every host
#
# WHY THIS IS NOT A BARE `set -e` LOOP OVER THE EXIT CODES:
#
# `agent validate` and `agent convert` route through `hasFindings`, which fails
# on any `approximate` diagnostic — correct for those two commands, and the
# reason a widened loop cannot gate on the exit code. Only claude-code renders
# this repository's bundles with no findings at all. The other four inherently
# carry warnings that are properties of the host, not defects in the bundle:
#
#   AB302  no portable ${ARGUMENTS} substitution     approximate
#   AB310  skill invocation policy is advisory       approximate
#   AB332  tool restrictions need a target override  approximate
#   AB340  no custom agents in the plugin profile    unsupported
#   AB370  project MCP requires TOML                 unsupported
#
# So claude-code keeps the exit-0 bar it has always had, and the other four are
# gated on `error` diagnostics instead. An invocation or I/O error (exit 1)
# fails everywhere. --strict holds every target to the exit-0 bar.

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

ALL_TARGETS=(claude-code codex cursor antigravity opencode)
TARGETS=()
ONLY_BUNDLES=()
OUT=""
GATE_STRICT=0

usage() {
  cat >&2 <<USAGE
Check every plugin bundle against every target.

Usage: scripts/check-bundles.sh [options] [target...]

Options:
  --bundle <name>   Check only this bundle (repeatable)
  --output <dir>    Conversion root (default: a temporary directory)
  --strict          Require zero findings on every target, not just claude-code
  -h, --help        Show this help

Targets (default: all of them):
  ${ALL_TARGETS[*]}

Gating:
  claude-code  any finding fails, as in CI today
  the rest     only \`error\` diagnostics fail; approximate and unsupported
               warnings are properties of the host and are reported, not blocked

Environment:
  CAIRN_BIN         Override the cairn invocation
  CAIRN_NO_BUILD=1  Never build; fall back to cairn on PATH
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) ONLY_BUNDLES+=("${2:?--bundle needs a value}"); shift 2 ;;
    --bundle=*) ONLY_BUNDLES+=("${1#*=}"); shift ;;
    --output) OUT="${2:?--output needs a value}"; shift 2 ;;
    --output=*) OUT="${1#*=}"; shift ;;
    --strict) GATE_STRICT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) TARGETS+=("$1"); shift ;;
  esac
done

discover_bundles

if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=("${ALL_TARGETS[@]}")
else
  for t in "${TARGETS[@]}"; do
    case " ${ALL_TARGETS[*]} " in
      *" $t "*) ;;
      *) die "unknown target '$t' (known: ${ALL_TARGETS[*]})" ;;
    esac
  done
fi

BUNDLES=("${ALL_BUNDLES[@]}")
if [ ${#ONLY_BUNDLES[@]} -gt 0 ]; then
  BUNDLES=()
  for name in "${ONLY_BUNDLES[@]}"; do
    case " ${ALL_BUNDLES[*]} " in
      *" $name "*) BUNDLES+=("$name") ;;
      *) die "unknown bundle '$name' (known: ${ALL_BUNDLES[*]})" ;;
    esac
  done
fi

resolve_cairn

if [ -z "$OUT" ]; then
  OUT="$(mktemp -d)"
  trap 'rm -rf "$OUT"' EXIT
else
  mkdir -p "$OUT"
fi
PAYLOAD="$OUT/.payload.json"

# Groups fold in the Actions log and are inert in a terminal.
group_open()  { [ -n "${GITHUB_ACTIONS:-}" ] && printf '::group::%s\n' "$*" || step "$*"; }
group_close() { [ -n "${GITHUB_ACTIONS:-}" ] && printf '::endgroup::\n' || true; }

FAILURES=()
WARN_TALLY=""

# Decide one command's result from its payload rather than its exit status, and
# print the diagnostics either way — a tolerated warning still belongs in the log.
gate() {
  local target="$1" label="$2" rc="$3" strict="$4"
  node -e '
    const fs = require("node:fs");
    const [file, label, rc, strict] = process.argv.slice(1);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // No parseable payload and a nonzero exit is a real failure; a clean run
      // that wrote nothing parseable is one too, since every agent command
      // emits a payload on stdout under --format json.
      console.log(`  ${label}: no parseable JSON payload (exit ${rc})`);
      process.exit(1);
    }
    const diagnostics = payload.diagnostics ?? [];
    const count = (severity) => diagnostics.filter((d) => d.severity === severity).length;
    const errors = count("error");
    const warnings = count("warning");
    for (const d of diagnostics) {
      const quality = d.quality ? `/${d.quality}` : "";
      console.log(`  ${d.severity}${quality} ${d.code}: ${d.message}`);
    }
    const summary = `  ${label}: exit ${rc}, ${errors} error(s), ${warnings} warning(s)`;
    // Exit 1 is an invocation or I/O error and never a finding.
    if (Number(rc) === 1) {
      console.log(`${summary} — invocation or I/O error`);
      process.exit(1);
    }
    if (errors > 0) {
      console.log(`${summary} — blocked on errors`);
      process.exit(1);
    }
    if (strict === "1" && Number(rc) !== 0) {
      console.log(`${summary} — blocked under the exit-0 bar`);
      process.exit(1);
    }
    console.log(summary);
    // Report the warning count back for the tally.
    fs.writeSync(3, String(warnings));
  ' "$PAYLOAD" "$label" "$rc" "$strict" 3>"$OUT/.warnings"
}

run_check() {
  local target="$1" bundle="$2" label="$3"
  shift 3
  local rc=0 strict=0
  [ "$target" = "claude-code" ] && strict=1
  [ "$GATE_STRICT" -eq 1 ] && strict=1

  : >"$PAYLOAD"
  "${CAIRN[@]}" "$@" --format json >"$PAYLOAD" 2>"$OUT/.stderr" || rc=$?
  [ -s "$OUT/.stderr" ] && sed 's/^/  stderr: /' "$OUT/.stderr" >&2

  if gate "$target" "$label" "$rc" "$strict"; then
    [ -s "$OUT/.warnings" ] && WARN_TALLY="$WARN_TALLY$target $(cat "$OUT/.warnings")"$'\n'
    return 0
  fi
  FAILURES+=("$target/$bundle/$label")
  return 1
}

for target in "${TARGETS[@]}"; do
  for name in "${BUNDLES[@]}"; do
    bundle="$(bundle_path "$name")"
    conv="$OUT/$target/$name"
    group_open "$target / $name"
    # `agent validate` takes no --profile. `agent doctor --output` takes a
    # *conversion* root, never a package or collection root, and the root is
    # per-target as well as per-bundle or doctor compares against another
    # host's tree.
    run_check "$target" "$name" validate \
      agent validate "$bundle" --target "$target" || true
    run_check "$target" "$name" convert \
      agent convert "$bundle" --target "$target" --profile plugin --output "$conv" || true
    run_check "$target" "$name" doctor \
      agent doctor "$bundle" --target "$target" --profile plugin --output "$conv" || true
    run_check "$target" "$name" test \
      agent test "$bundle" --target "$target" || true
    # `agent audit` without --strict: forwarded render warnings are expected,
    # while audit's own AUDIT_CODES warnings block regardless.
    run_check "$target" "$name" audit \
      agent audit "$bundle" --target "$target" --profile plugin || true
    group_close
  done
done

# One line per host: what portability costs, visible without reading the log.
if [ -n "$WARN_TALLY" ]; then
  info ""
  step "Warnings per target"
  printf '%s' "$WARN_TALLY" | awk '{ n[$1] += $2 } END { for (t in n) printf "  %-12s %d\n", t, n[t] }' |
    sort >&2
fi

if [ ${#FAILURES[@]} -gt 0 ]; then
  info ""
  die "${#FAILURES[@]} check(s) failed:"$'\n'"$(printf '  %s\n' "${FAILURES[@]}")"
fi

info ""
ok "All checks passed across ${#TARGETS[@]} target(s) and ${#BUNDLES[@]} bundle(s)."
