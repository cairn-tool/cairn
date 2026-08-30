#!/usr/bin/env bash
# PostToolUse: lint a Markdown file after Write or Edit.
#
# Every exit path is 0. This hook reports; it must never block an edit, and a
# missing tool is a normal state rather than an error worth surfacing.
set -u

INPUT=$(cat)

# jq if it is here, a narrow sed extraction if it is not. Requiring jq would
# make the hook fail silently on a machine that does not have it.
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
else
  FILE_PATH=$(printf '%s' "$INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi

[ -n "$FILE_PATH" ] || exit 0

case "$FILE_PATH" in
  *.md | *.markdown) ;;
  *) exit 0 ;;
esac

# The file may have been deleted between the tool call and this hook.
[ -f "$FILE_PATH" ] || exit 0

# cairn is published to a private registry and installed separately. Its absence
# is expected, not an error: resolve it from PATH and leave quietly if it is not
# there. Never hardcode an install path -- it breaks on every Node upgrade under
# a version manager.
command -v cairn >/dev/null 2>&1 || exit 0

cairn md lint "$FILE_PATH" 2>/dev/null || true
exit 0
