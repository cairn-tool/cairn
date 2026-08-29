# 013. `agent test`

| Priority | Effort       | Status  |
| -------- | ------------ | ------- |
| P2       | Medium-large | Shipped |

**Payoff:** Catch behavioral-contract and artifact regressions.

Delivered by [`agent test`](../../commands/agent-test.md). The proposal below is the original
text; where the implementation diverged, the command's own documentation is authoritative.

Test cases live at `tests/*.test.yaml` under the bundle root by convention rather than behind a
manifest key, which keeps bundle `schemaVersion` 2 a strict superset of 1 and lets a v1 or
legacy bundle carry tests. The assertion families shipped as five orthogonal ones — rendered
paths, file text and mode, JSON fragments, diagnostics, and golden digests — which together
cover every item the sketch lists. Golden digests are read, never rewritten: `agent test`
writes nothing, and a mismatch reports the actual value for the author to paste back.

`--native` was deliberately **not** implemented. Every shipped target profile declares
`nativeValidator: null`, the profile schema states that this CLI never executes it, and
`scripts run` is the only command that executes anything. `test.native` is reserved in the
payload and always empty; [`agent specs`](../../commands/agent-specs.md) publishes each
target's validator command to run yourself. Model-driven behavioral evaluation remains out of
scope for the same reason the proposal gives.

**Command sketch:**

```text
cairn agent test ./bundle
cairn agent test ./bundle --target all --native
```

Support model-free contract tests stored with a bundle. Test cases could assert selected
targets/profiles, rendered paths, manifest fragments, compatibility diagnostics, transformed
placeholders, hook schemas, policy examples, and golden output digests.

An opt-in `--native` mode could run installed host validators in temporary directories with
timeouts and no network. Model-driven behavioral evaluations should be a later, explicitly
configured integration: they are nondeterministic, can cost money, and should not become a
requirement for ordinary validation.

---

[Back to the idea index](_contents.md)
