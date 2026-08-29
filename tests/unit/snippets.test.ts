import { describe, it, expect } from "vitest";
import { extractCodeBlocks, parseMarkdown } from "../../src/markdown-ast.js";
import {
  dedent,
  extractRegion,
  normalizeSnippet,
  parseSnippetLink,
  snippetEdits,
  synchronizeSnippets,
  type SnippetSynchronization,
  type SourceRead,
} from "../../src/snippets.js";

function blocks(content: string) {
  return extractCodeBlocks(parseMarkdown(content));
}

function link(content: string) {
  return parseSnippetLink(blocks(content)[0]);
}

/** A reader that serves one canned source, bypassing the filesystem guards. */
function reader(content: string): (resolved: string) => SourceRead {
  return () => ({ status: "read", content, fingerprint: { size: content.length, mtimeMs: 1 } });
}

function sync(document: string, source: string, file = "/w/docs/a.md"): SnippetSynchronization[] {
  return synchronizeSnippets(document, blocks(document), {
    file,
    root: "/w",
    read: reader(source),
  });
}

describe("parseSnippetLink", () => {
  it("ignores a fence with no attribute", () => {
    expect(link("```ts\nconst a = 1;\n```\n")).toEqual({ status: "unlinked" });
    expect(link('```ts title="x"\nconst a = 1;\n```\n')).toEqual({ status: "unlinked" });
  });

  it("reads a bare target with a region", () => {
    expect(link("```ts cairn:snippet=src/toc.ts#render\na\n```\n")).toEqual({
      status: "linked",
      targetPath: "src/toc.ts",
      selector: { kind: "region", name: "render" },
    });
  });

  it("treats a missing fragment as the whole file", () => {
    expect(link("```json cairn:snippet=.markdownlintrc\na\n```\n")).toEqual({
      status: "linked",
      targetPath: ".markdownlintrc",
      selector: { kind: "file" },
    });
  });

  it("accepts a quoted target and leaves other attributes alone", () => {
    expect(link('```ts title="x" cairn:snippet="src/my dir/a.ts#r" {1,3}\na\n```\n')).toEqual({
      status: "linked",
      targetPath: "src/my dir/a.ts",
      selector: { kind: "region", name: "r" },
    });
  });

  it("reports a fence that omits the language", () => {
    // A language-less fence puts the whole info string into `lang`, so the
    // link would otherwise be inert with no way for an author to notice.
    const result = link("``` cairn:snippet=src/a.ts#r\na\n```\n");
    expect(result).toMatchObject({ status: "malformed", reason: "no-language" });
  });

  it("reports a duplicate attribute", () => {
    const result = link("```ts cairn:snippet=a.ts cairn:snippet=b.ts\nx\n```\n");
    expect(result).toMatchObject({ status: "malformed", reason: "duplicate-attribute" });
  });

  it("reports an empty target and a malformed region name", () => {
    expect(link("```ts cairn:snippet=#r\nx\n```\n")).toMatchObject({
      reason: "empty-target",
    });
    expect(link("```ts cairn:snippet=a.ts#bad/name\nx\n```\n")).toMatchObject({
      reason: "malformed-region-name",
    });
    expect(link("```ts cairn:snippet=a.ts#-lead\nx\n```\n")).toMatchObject({
      reason: "malformed-region-name",
    });
    expect(link("```ts cairn:snippet=a.ts#\nx\n```\n")).toMatchObject({
      reason: "malformed-region-name",
    });
  });

  it("ends an unquoted value at the first space", () => {
    // A path containing a space has to be quoted; without this, the next
    // attribute in the info string would be swallowed into the path.
    expect(link("```ts cairn:snippet=a.ts#r other=1\nx\n```\n")).toEqual({
      status: "linked",
      targetPath: "a.ts",
      selector: { kind: "region", name: "r" },
    });
  });

  it("does not match a directive inside a documenting fence", () => {
    // The whole reason the link lives in `Code.meta` rather than in the raw
    // text: remark reports the inner fence as characters in the outer block's
    // value, so an example can never be mistaken for a live link.
    const found = blocks("````md\n```ts cairn:snippet=src/a.ts#r\nx\n```\n````\n");
    expect(found).toHaveLength(1);
    expect(parseSnippetLink(found[0])).toEqual({ status: "unlinked" });
  });
});

describe("dedent", () => {
  it("strips the common prefix and empties blank lines", () => {
    expect(dedent(["    a", "      b", "   ", "    c"])).toEqual(["a", "  b", "", "c"]);
  });

  it("strips nothing when tabs and spaces are mixed", () => {
    expect(dedent(["\ta", "    b"])).toEqual(["\ta", "    b"]);
  });

  it("is idempotent", () => {
    const once = dedent(["  a", "    b"]);
    expect(dedent(once)).toEqual(once);
  });
});

describe("normalizeSnippet", () => {
  it("ignores line endings, trailing spaces, and trailing blank lines", () => {
    expect(normalizeSnippet("a\r\nb  \n\n\n")).toBe("a\nb");
  });

  it("keeps interior blank lines and indentation", () => {
    expect(normalizeSnippet("a\n\n  b")).toBe("a\n\n  b");
  });
});

describe("extractRegion", () => {
  const source = [
    "// cairn:snippet:start render",
    "  export function render() {",
    "    return 1;",
    "  }",
    "// cairn:snippet:end render",
    "const other = 2;",
  ].join("\n");

  it("takes the lines between the markers and dedents them", () => {
    expect(extractRegion(source, { kind: "region", name: "render" })).toEqual({
      status: "found",
      text: "export function render() {\n  return 1;\n}",
    });
  });

  it("matches markers under any comment leader", () => {
    for (const leader of ["#", "--", "/*", "<!--", ";;"]) {
      const text = `${leader} cairn:snippet:start r\nbody\n${leader} cairn:snippet:end r`;
      expect(extractRegion(text, { kind: "region", name: "r" })).toEqual({
        status: "found",
        text: "body",
      });
    }
  });

  it("does not match a longer name that merely starts with the marker", () => {
    const text = "// cairn:snippet:startup r\nbody\n";
    expect(extractRegion(text, { kind: "region", name: "r" })).toMatchObject({
      reason: "region-missing",
    });
  });

  it("strips nested region scaffolding from the body", () => {
    const nested = [
      "// cairn:snippet:start outer",
      "a",
      "  // cairn:snippet:start inner",
      "b",
      "  // cairn:snippet:end inner",
      "c",
      "// cairn:snippet:end outer",
    ].join("\n");
    expect(extractRegion(nested, { kind: "region", name: "outer" })).toEqual({
      status: "found",
      text: "a\nb\nc",
    });
  });

  it("takes the whole file for a file selector, markers removed", () => {
    expect(extractRegion(source, { kind: "file" })).toEqual({
      status: "found",
      text: "  export function render() {\n    return 1;\n  }\nconst other = 2;",
    });
  });

  it("trims leading and trailing blank lines", () => {
    const padded = "// cairn:snippet:start r\n\n  a\n\n\n// cairn:snippet:end r";
    expect(extractRegion(padded, { kind: "region", name: "r" })).toEqual({
      status: "found",
      text: "a",
    });
  });

  it("normalizes CRLF sources", () => {
    const crlf = "// cairn:snippet:start r\r\na\r\nb\r\n// cairn:snippet:end r\r\n";
    expect(extractRegion(crlf, { kind: "region", name: "r" })).toEqual({
      status: "found",
      text: "a\nb",
    });
  });

  it("reports every way a region can be unusable", () => {
    const cases: Array<[string, string]> = [
      ["body only", "region-missing"],
      ["// cairn:snippet:end r", "region-missing"],
      ["// cairn:snippet:start r\nx", "region-unterminated"],
      ["// cairn:snippet:end r\nx\n// cairn:snippet:start r", "region-inverted"],
      [
        [
          "// cairn:snippet:start r",
          "// cairn:snippet:end r",
          "// cairn:snippet:start r",
          "// cairn:snippet:end r",
        ].join("\n"),
        "region-ambiguous",
      ],
    ];
    for (const [text, reason] of cases) {
      expect(extractRegion(text, { kind: "region", name: "r" }), text).toMatchObject({
        status: "failed",
        reason,
      });
    }
  });

  it("skips markers inside fenced code when the source is Markdown", () => {
    // This project's own command page will show the marker syntax in a fence.
    const doc = ["```ts", "// cairn:snippet:start r", "fake", "```", "real"].join("\n");
    expect(extractRegion(doc, { kind: "region", name: "r" }, true)).toMatchObject({
      reason: "region-missing",
    });
    expect(extractRegion(doc, { kind: "region", name: "r" }, false)).toMatchObject({
      reason: "region-unterminated",
    });
  });
});

describe("synchronizeSnippets", () => {
  const source = "// cairn:snippet:start r\nconst a = 1;\n// cairn:snippet:end r\n";

  it("skips unlinked blocks entirely", () => {
    expect(sync("```ts\nconst a = 1;\n```\n", source)).toEqual([]);
  });

  it("reports a matching block as current", () => {
    const result = sync("```ts cairn:snippet=../src/a.ts#r\nconst a = 1;\n```\n", source);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: "current", target: "../src/a.ts#r" });
  });

  it("ignores trailing whitespace and line endings when comparing", () => {
    const result = sync("```ts cairn:snippet=../src/a.ts#r\nconst a = 1;   \n```\n", source);
    expect(result[0].status).toBe("current");
  });

  it("reports drift with both bodies and a write plan", () => {
    const document = "```ts cairn:snippet=../src/a.ts#r\nconst a = 2;\n```\n";
    const result = sync(document, source);
    expect(result[0]).toMatchObject({
      status: "stale",
      documented: "const a = 2;",
      expected: "const a = 1;",
    });
    const [edit] = snippetEdits("/w/docs/a.md", document, result);
    expect(document.slice(edit.start, edit.end)).toBe("const a = 2;\n");
    expect(edit.replacement).toBe("const a = 1;\n");
    expect(edit.diagnostic).toEqual({
      rule: "snippets",
      line: 1,
      message: "Snippet is out of date with ../src/a.ts#r",
    });
  });

  it("forwards a source read failure as unresolved", () => {
    const result = synchronizeSnippets(
      "```ts cairn:snippet=../src/a.ts#r\nx\n```\n",
      blocks("```ts cairn:snippet=../src/a.ts#r\nx\n```\n"),
      {
        file: "/w/docs/a.md",
        root: "/w",
        read: () => ({ status: "failed", reason: "source-not-found", message: "gone" }),
      },
    );
    expect(result[0]).toMatchObject({ status: "unresolved", reason: "source-not-found" });
  });

  it("reports a missing region as unresolved, naming the path as written", () => {
    const result = sync("```ts cairn:snippet=../src/a.ts#nope\nx\n```\n", source);
    expect(result[0]).toMatchObject({ status: "unresolved", reason: "region-missing" });
    expect((result[0] as { message: string }).message).toContain("../src/a.ts");
  });
});

describe("write planning", () => {
  const source = "// cairn:snippet:start r\nconst a = 1;\n// cairn:snippet:end r\n";

  function plan(document: string) {
    const result = sync(document, source);
    expect(result[0].status).toBe("stale");
    return result[0] as Extract<SnippetSynchronization, { status: "stale" }>;
  }

  it("preserves the fence line and every other attribute", () => {
    const document = '```ts title="x" cairn:snippet=../src/a.ts#r {1,3}\nconst a = 2;\n```\n';
    const write = plan(document).write!;
    expect(document.slice(0, write.start) + write.interior + document.slice(write.end)).toBe(
      '```ts title="x" cairn:snippet=../src/a.ts#r {1,3}\nconst a = 1;\n```\n',
    );
  });

  it("re-applies the indentation of a fence inside a list item", () => {
    const document = "- item\n\n  ```ts cairn:snippet=../src/a.ts#r\n  const a = 2;\n  ```\n";
    const write = plan(document).write!;
    expect(document.slice(0, write.start) + write.interior + document.slice(write.end)).toBe(
      "- item\n\n  ```ts cairn:snippet=../src/a.ts#r\n  const a = 1;\n  ```\n",
    );
  });

  it("preserves the document's CRLF line endings", () => {
    const document = "```ts cairn:snippet=../src/a.ts#r\r\nconst a = 2;\r\n```\r\n";
    expect(plan(document).write!.interior).toBe("const a = 1;\r\n");
  });

  it("refuses a blockquoted fence but still reports the drift", () => {
    const document = "> ```ts cairn:snippet=../src/a.ts#r\n> const a = 2;\n> ```\n";
    const result = plan(document);
    expect(result.write).toBeUndefined();
    expect(result.unwritable).toMatchObject({ reason: "container-prefix" });
  });

  it("refuses when the source would close the fence early", () => {
    const fenced = "// cairn:snippet:start r\n```\n// cairn:snippet:end r\n";
    const document = "```text cairn:snippet=../src/a.ts#r\nold\n```\n";
    const result = sync(document, fenced)[0] as Extract<
      SnippetSynchronization,
      { status: "stale" }
    >;
    expect(result.unwritable).toMatchObject({ reason: "fence-collision" });
  });

  it("accepts a longer fence that the body cannot close", () => {
    const fenced = "// cairn:snippet:start r\n```\n// cairn:snippet:end r\n";
    const document = "````text cairn:snippet=../src/a.ts#r\nold\n````\n";
    const result = sync(document, fenced)[0] as Extract<
      SnippetSynchronization,
      { status: "stale" }
    >;
    expect(result.write?.interior).toBe("```\n");
  });

  it("writes a fence whose closing line ends the file without a newline", () => {
    const document = "```ts cairn:snippet=../src/a.ts#r\nold\n```";
    const write = plan(document).write!;
    expect(write.end).toBe(document.lastIndexOf("```"));
    expect(document.slice(0, write.start) + write.interior + document.slice(write.end)).toBe(
      "```ts cairn:snippet=../src/a.ts#r\nconst a = 1;\n```",
    );
  });

  it("refuses a fence left unterminated at end of file", () => {
    // Adding the missing closing fence would change the document's structure
    // rather than refresh a snippet.
    const result = plan("```ts cairn:snippet=../src/a.ts#r\nold\n");
    expect(result.write).toBeUndefined();
    expect(result.unwritable).toMatchObject({ reason: "unterminated-fence" });
  });

  it("is idempotent: the written body compares clean", () => {
    const document = "```ts cairn:snippet=../src/a.ts#r\nconst a = 2;\n```\n";
    const write = plan(document).write!;
    const next = document.slice(0, write.start) + write.interior + document.slice(write.end);
    expect(sync(next, source)[0].status).toBe("current");
  });
});
