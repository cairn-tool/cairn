---
name: agent-check
description: Validate, doctor, test, and audit an agent bundle with cairn.
argument-hint: "[bundle-path]"
---

# Check an agent bundle

Run the full verification sequence on the bundle at `$ARGUMENTS`, or the current directory if
none was given. Stop at the first failure and report it.

```bash
cairn agent validate <bundle> --target all
cairn agent convert  <bundle> --target claude-code --profile plugin --output "$(mktemp -d)"
cairn agent doctor   <bundle> --target claude-code --profile plugin --output <that dir>
cairn agent test     <bundle>
cairn agent audit    <bundle> --target claude-code --profile plugin
```

Notes that change the result:

- `agent validate` takes no `--profile`.
- `agent doctor --output` takes a **conversion** root, never a package or collection root.
- Run `agent audit` **without** `--strict`: forwarded render warnings are expected, and audit's
  own findings block regardless.

Summarize as a single verdict, then the findings that need action.
