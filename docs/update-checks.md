# Update checks

The CLI checks whether a newer version has been published and prints a notice:

```text
Update available 1.0.3 → 1.1.0
Run npm install -g @cairn-tool/cairn to update.
```

The check runs **at most once every 24 hours**, in a detached background process, so it
never delays a command. The notice itself is printed from the cached result, which means
it appears at most 24 hours after a release.

It is deliberately silent unless it is safe and useful to speak. No notice is printed when:

- stderr is not a TTY — output is being piped or parsed
- `--format json`, `jsonl`, or `sarif` is in use
- `CI` is set
- `CAIRN_NO_UPDATE_NOTIFIER=1` is set

Set `CAIRN_NO_UPDATE_NOTIFIER=1` to disable the feature entirely, including the
background refresh.

The cached result lives at `${XDG_CACHE_HOME:-~/.cache}/cairn/update-check.json` and
can be deleted at any time to force a fresh check.

## Why it is silent so often

The notice must never reach a stream a consumer is parsing. Both stdout and stderr carry payloads
depending on the command — `md lint --format json` puts JSON on stderr when it has findings and
on stdout when it does not — so the notifier refuses to print unless every gate above passes.
Changing those gates risks corrupting a consumer's parse, which is why they are listed here
rather than treated as an implementation detail.

The notice prints from cache in a `process.on("exit")` handler, and the network refresh happens
in a detached child guarded by an atomic lock file, so concurrent invocations spawn at most one
refresh and no command ever waits on the network.

## Related

- [`check-update`](commands/check-update.md) — check immediately, bypassing the cache.
- [Installing Cairn](install.md).
