# `md check-urls`

## Synopsis

```text
cairn md check-urls <inputs...> [options]
```

Extracts and deduplicates external URLs across files, directories, globs, or stdin while
retaining every source occurrence in reports. Requests use HEAD first and fall back to GET
for configured statuses. Raw results can be cached at
`${XDG_CACHE_HOME:-~/.cache}/cairn/url-checks.json`; cache failures are non-fatal.

## Arguments

| Argument    | Required | Description                                           |
| ----------- | -------- | ----------------------------------------------------- |
| `inputs...` | Yes      | Markdown files, directories, globs, or `-` for stdin. |

## Options

| Option                                         | Default                          | Description                                                     |
| ---------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| `--format <fmt>`                               | Project default                  | `llm`, `human`, `json`, `jsonl`, or `sarif`.                    |
| `--paths <style>`                              | Project default                  | `absolute` or `relative`.                                       |
| `--stdin-name <path>`                          | None                             | Logical path for stdin.                                         |
| `--timeout <ms>`                               | `5000`                           | Positive request timeout per URL.                               |
| `--concurrency <n>`                            | `5`                              | Positive maximum concurrent requests.                           |
| `--retry <n>`                                  | `1`                              | Non-negative retry count.                                       |
| `--include-ok` / `--no-include-ok`             | `false`                          | Include or suppress successful URL results.                     |
| `--include <glob>`                             | `files.include`                  | Repeatable Markdown include glob.                               |
| `--exclude <glob>`                             | `files.exclude`                  | Repeatable Markdown exclude glob.                               |
| `--changed-since <revision>`                   | None                             | Intersect input selection with Git changes.                     |
| `--ignore <glob>`                              | `urls.ignore`                    | Repeatable URL minimatch glob to ignore.                        |
| `--ignore-domain <domain>`                     | `urls.ignoreDomains`             | Repeatable domain; also ignores subdomains.                     |
| `--allowed-status <code>`                      | `urls.allowedStatuses`           | Repeatable HTTP status from 100 through 599 treated as allowed. |
| `--cache` / `--no-cache`                       | `urls.cache` (`true`)            | Enable or disable raw-result caching.                           |
| `--cache-ttl <ms>`                             | `urls.cacheTtl` (`86400000`)     | Non-negative cache lifetime in milliseconds.                    |
| `--head-fallback-status <code>`                | `400`, `403`, `405`, `501`       | Repeatable HEAD status that triggers GET.                       |
| `--report-redirects` / `--no-report-redirects` | `urls.reportRedirects` (`false`) | Include redirect state and final destinations.                  |
| `-h`, `--help`                                 | —                                | Show help.                                                      |

CLI URL options override `commands.check-urls`, which overrides `urls`. Exit `0` means all
checked URLs are reachable or none were found; broken URLs exit `2`; operational errors exit
`1`.
