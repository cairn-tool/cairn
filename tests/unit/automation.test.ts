import { describe, expect, it } from "vitest";
import { formatJsonl, formatSarif } from "../../src/automation.js";

const issue = { file: "docs/a.md", line: 3, checker: "ref/link", message: "missing" };

describe("automation formats", () => {
  it("ends JSONL findings with a summary record", () => {
    const records = formatJsonl([issue], { files: 1, findings: 1 })
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      { type: "finding", ...issue },
      { type: "summary", files: 1, findings: 1 },
    ]);
  });

  it("emits SARIF 2.1.0 locations", () => {
    const sarif = JSON.parse(formatSarif([issue])) as {
      version: string;
      runs: Array<{
        results: Array<{
          ruleId: string;
          locations: Array<{ physicalLocation: { region: { startLine: number } } }>;
        }>;
      }>;
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0].ruleId).toBe("ref/link");
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBe(3);
  });

  // Byte equality, not field spot-checks: `formatSarif` now shares its envelope
  // with `agent audit` through `sarifDocument`, and `JSON.stringify` follows
  // insertion order, so a reordered key would silently change what every
  // consumer of `md lint --format sarif` receives.
  it("emits byte-identical SARIF for a fixed input", () => {
    expect(formatSarif([issue])).toBe(
      [
        "{",
        '  "version": "2.1.0",',
        '  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",',
        '  "runs": [',
        "    {",
        '      "tool": {',
        '        "driver": {',
        '          "name": "cairn",',
        '          "informationUri": "https://github.com/cairn-tool/cairn",',
        '          "rules": [',
        "            {",
        '              "id": "ref/link",',
        '              "name": "ref/link"',
        "            }",
        "          ]",
        "        }",
        "      },",
        '      "results": [',
        "        {",
        '          "ruleId": "ref/link",',
        '          "level": "error",',
        '          "message": {',
        '            "text": "missing"',
        "          },",
        '          "locations": [',
        "            {",
        '              "physicalLocation": {',
        '                "artifactLocation": {',
        '                  "uri": "docs/a.md"',
        "                },",
        '                "region": {',
        '                  "startLine": 3',
        "                }",
        "              }",
        "            }",
        "          ]",
        "        }",
        "      ]",
        "    }",
        "  ]",
        "}",
      ].join("\n"),
    );
  });
});
