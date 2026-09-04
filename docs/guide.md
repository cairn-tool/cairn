# Guides

One page per toolset, answering _why it exists_ and the two or three facts that make its answers
trustworthy. Per-command flags are not here — those are in the
[complete command listing](commands.md) and the pages under `commands/`.

| Guide                                          | Toolset   | Covers                                                                     |
| ---------------------------------------------- | --------- | -------------------------------------------------------------------------- |
| [Agent bundles](guide/agent-bundles.md)        | `agent`   | One neutral bundle rendered for five hosts, and keeping the output honest. |
| [Markdown](guide/markdown.md)                  | `md`      | The document graph, the checks, and what may be rewritten.                 |
| [Named scripts](guide/scripts.md)              | `scripts` | Resolving a command by name, and the guards that make running one safe.    |
| [Usage reporting](guide/usage.md)              | `usage`   | What the transcripts hold, and why the numbers are not a line count.       |
| [Long-term archiving](guide/archiving.md)      | `archive` | Keeping what a session produced, and getting it back.                      |
| [Jira and Confluence rich text](guide/jira.md) | `jira`    | Converting between ADF and Markdown, and what each direction costs.        |
| [Reading PDF documents](guide/pdf.md)          | `pdf`     | Text layers, tagged versus untagged, and why conversion is lossy.          |

## Related

- [Complete command listing](commands.md) — every command, with a one-line description.
- [File formats and schemas](formats.md) — the files Cairn itself reads and writes.
- [Providers](providers.md) — what is known about each assistant's own formats.
- [Cairn's own plugins](plugins.md) — the toolsets, shipped as agent bundles.
