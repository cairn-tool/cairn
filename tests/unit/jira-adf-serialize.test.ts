import { describe, expect, it } from "vitest";
import { canonicalize, serializeAdf } from "../../src/jira/adf/serialize.js";
import type { AdfDocument } from "../../src/jira/adf/types.js";

/**
 * Key order in emitted ADF is contract.
 *
 * `JSON.stringify` follows insertion order, so a consumer diffing converted ADF
 * in Git sees every reordering as a change. This is the same discipline
 * `tests/unit/automation.test.ts` applies to `src/sarif.ts`: assert the bytes
 * against a fixed input, so a refactor that reorders a key fails here rather
 * than in someone's review.
 */
describe("ADF serialization", () => {
  const scrambled: AdfDocument = {
    // Deliberately in the wrong order, with a nested node also scrambled.
    content: [
      {
        marks: [{ attrs: { href: "https://example.com" }, type: "link" }],
        text: "hi",
        type: "text",
      } as never,
      {
        content: [{ type: "text", text: "x" }],
        attrs: { level: 2 },
        type: "heading",
      },
    ],
    type: "doc",
    version: 1,
  };

  it("emits keys in the canonical order regardless of input order", () => {
    expect(serializeAdf(scrambled)).toBe(
      `{
  "version": 1,
  "type": "doc",
  "content": [
    {
      "type": "text",
      "marks": [
        {
          "type": "link",
          "attrs": {
            "href": "https://example.com"
          }
        }
      ],
      "text": "hi"
    },
    {
      "type": "heading",
      "attrs": {
        "level": 2
      },
      "content": [
        {
          "type": "text",
          "text": "x"
        }
      ]
    }
  ]
}
`,
    );
  });

  it("sorts attribute keys by byte comparison, not locale", () => {
    const document: AdfDocument = {
      version: 1,
      type: "doc",
      content: [
        {
          type: "media",
          // Uppercase sorts before lowercase in byte order; a locale-aware
          // comparison would interleave them and vary by ICU build.
          attrs: { url: "u", alt: "a", Z: 1, collection: "c" },
        },
      ],
    };
    const attrs = canonicalize(document).content?.[0].attrs ?? {};
    expect(Object.keys(attrs)).toEqual(["Z", "alt", "collection", "url"]);
  });

  it("omits absent keys rather than emitting nulls", () => {
    const serialized = serializeAdf({
      version: 1,
      type: "doc",
      content: [{ type: "rule" }],
    });
    expect(serialized).not.toContain("null");
    expect(serialized).not.toContain("attrs");
    expect(serialized).not.toContain("marks");
  });

  it("ends with exactly one newline", () => {
    const serialized = serializeAdf({ version: 1, type: "doc", content: [] });
    expect(serialized.endsWith("}\n")).toBe(true);
    expect(serialized.endsWith("}\n\n")).toBe(false);
  });

  it("is idempotent", () => {
    const once = canonicalize(scrambled);
    expect(serializeAdf(once)).toBe(serializeAdf(canonicalize(once)));
  });
});
