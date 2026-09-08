# Future enhancements

Work that is designed enough to name, and not in the current build.

## Windows for the `qa` toolset

`qa` is POSIX-only. Three substitutions would have to land together; any one of them alone would
leave a queue that looks like it is running and is not:

1. **Process-group signalling.** `process.kill(-pid)` has no meaning on Windows. The replacement
   is a job object, or `taskkill /T`, so a timed-out agent and everything it spawned actually die.
2. **`lock.ts`.** The lock uses `O_EXLOCK`. Windows needs a pid-file liveness check (or an
   equivalent exclusive lock) so a second `qa run` against the same `--runs-dir` still refuses.
3. **The TUI.** Raw mode and the alternate screen need a verified pass in Windows Terminal. Until
   that exists, even a working spawn path should force `--no-tui` there rather than guess.

Until those are done, invocation on `win32` exits 1.

## A `plugins/cairn-qa` bundle

Every other toolset ships as an agent bundle under `plugins/`. `qa` does not yet. The follow-on is
the same shape: a plugin that exposes the commands as skills, without an MCP tool that runs a
case — `qa run` stays off the read-only server, the same rule as `scripts run`.
