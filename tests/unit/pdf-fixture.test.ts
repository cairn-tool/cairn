import { describe, expect, it } from "vitest";
import { withDocument } from "../../src/pdf/document.js";
import type { OpenDocument } from "../../src/pdf/document.js";
import { hasStructContent } from "../../src/pdf/inspect.js";
import { extractPage, runsToText } from "../../src/pdf/text.js";
import { pdfFixture } from "../helpers/pdf-fixture.js";

/**
 * The fixture builder, tested by the library it feeds.
 *
 * `tests/helpers/pdf-fixture.ts` hand-assembles PDFs so the damaged cases exist
 * at all — a writer library cannot emit a broken cross-reference table. The cost
 * of hand-assembling is that the fixtures themselves could be wrong, and this is
 * what pays it: every fixture goes back through `pdfjs-dist` and is asserted
 * against what the builder claims it built.
 */

const limits = { timeoutMs: 20_000, maxPages: 100 };

function open<T>(key: string, body: (handle: OpenDocument) => Promise<T>): Promise<T> {
  return withDocument(pdfFixture(key), limits, body);
}

describe("the generated fixtures parse", () => {
  it("minimal carries one page of readable text", async () => {
    await open("minimal", async (handle) => {
      expect(handle.doc.numPages).toBe(1);
      const page = await extractPage(handle, 1);
      expect(runsToText(page.runs)).toBe("Hello from a minimal PDF.");
      expect(handle.notices).toEqual([]);
    });
  });

  it("structured carries four pages, headings, and a running header", async () => {
    await open("structured", async (handle) => {
      expect(handle.doc.numPages).toBe(4);
      const text = runsToText((await extractPage(handle, 1)).runs);
      expect(text).toContain("Quarterly Report");
      expect(text).toContain("Introduction");
      // The hyphen the converter has to rejoin, still split in the raw layer.
      expect(text).toContain("Reve-");
    });
  });

  it("structured writes the bullet as its WinAnsi byte, not its code point", async () => {
    // The trap this asserts against: a code point emitted as octal is five
    // digits and a PDF lexer reads three, so U+2022 became "€42" on the page.
    await open("structured", async (handle) => {
      const text = runsToText((await extractPage(handle, 2)).runs);
      expect(text).toContain("•");
      expect(text).not.toContain("42The");
    });
  });

  it("tagged declares /MarkInfo and carries a usable structure tree", async () => {
    await open("tagged", async (handle) => {
      const markInfo = await handle.doc.getMarkInfo();
      // A Map, not an object: reading `.Marked` is always undefined and would
      // report every document as untagged.
      expect(markInfo).toBeInstanceOf(Map);
      expect((markInfo as Map<string, boolean>).get("Marked")).toBe(true);

      const proxy = await handle.doc.getPage(1);
      const tree = await proxy.getStructTree();
      expect(hasStructContent(tree)).toBe(true);
    });
  });

  it("tagged pairs marked-content ids between the tree and the text layer", async () => {
    // The whole tagged path rests on these two being the same string.
    await open("tagged", async (handle) => {
      const proxy = await handle.doc.getPage(1);
      const tree = await proxy.getStructTree();
      const ids: string[] = [];
      const walk = (node: { id?: string; children?: unknown[] }): void => {
        if (node.id) ids.push(node.id);
        for (const child of (node.children ?? []) as { id?: string; children?: unknown[] }[])
          walk(child);
      };
      walk(tree as { id?: string; children?: unknown[] });

      const page = await extractPage(handle, 1, { markedContent: true });
      const attributed = new Set(page.runs.map((run) => run.mcid).filter(Boolean));
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(attributed.has(id)).toBe(true);
    });
  });

  it("outlined carries a two-level outline with one unresolvable destination", async () => {
    await open("outlined", async (handle) => {
      const outline = (await handle.doc.getOutline()) as { title: string; items?: unknown[] }[];
      expect(outline.map((entry) => entry.title)).toEqual([
        "Chapter One",
        "Chapter Two",
        "Dangling",
      ]);
      expect(outline[0].items).toHaveLength(1);
    });
  });

  it("noTextLayer draws ink and emits no glyphs", async () => {
    await open("noTextLayer", async (handle) => {
      const page = await extractPage(handle, 1);
      expect(page.runs).toEqual([]);
      expect(page.characters).toBe(0);
    });
  });

  it("manyPages generates the page count it claims", async () => {
    await open("manyPages", async (handle) => {
      expect(handle.doc.numPages).toBe(40);
    });
  });

  it("damagedXref still opens, and the parser says it rebuilt the table", async () => {
    await open("damagedXref", async (handle) => {
      expect(handle.doc.numPages).toBe(1);
      // The string `pdf validate` keys AP101 on. If a pdfjs upgrade rewords it,
      // this fails here rather than silently turning that check off.
      expect(handle.notices.join("\n")).toMatch(/Indexing all PDF objects/);
    });
  });

  it("truncated still opens, so truncation is a recovery rather than a failure", async () => {
    await open("truncated", async (handle) => {
      expect(handle.doc.numPages).toBe(1);
      expect(handle.notices.join("\n")).toMatch(/Indexing all PDF objects/);
    });
  });

  it("pageTreeCycle opens but refuses its page", async () => {
    await open("pageTreeCycle", async (handle) => {
      await expect(handle.doc.getPage(1)).rejects.toThrow(/circular reference/i);
    });
  });

  it("attached carries two embedded files, one storing a traversing name", async () => {
    await open("attached", async (handle) => {
      const entries = await handle.doc.getAttachments();
      // A Map, like getMarkInfo, getFieldObjects and getJSActions. Object.entries
      // on any of the four silently yields nothing.
      expect(entries).toBeInstanceOf(Map);
      expect([...entries!.keys()].sort()).toEqual(["data.csv", "escape.csv"]);

      // pdf.js strips the path itself and keeps the raw name beside it. The
      // extractor does not rely on that, but the fixture has to exercise it.
      const escaped = entries!.get("escape.csv")!;
      expect(escaped.filename).toBe("evil.csv");
      expect(escaped.rawFilename).toBe("../../etc/evil.csv");

      // Content is a separate lazy call: the lookup above carries no bytes.
      expect(escaped.content).toBeUndefined();
      const bytes = await handle.doc.getAttachmentContent("data.csv");
      expect(Buffer.from(bytes!).toString()).toBe("hello,world\n1,2\n");
    });
  });

  it("formFilled carries four AcroForm fields with values", async () => {
    await open("formFilled", async (handle) => {
      const fields = await handle.doc.getFieldObjects();
      expect(fields).toBeInstanceOf(Map);
      expect([...fields!.keys()].sort()).toEqual(["agree", "fullName", "internal", "reference"]);
      // The value is an array, one entry per widget, and `page` is 0-based.
      const [name] = fields!.get("fullName") as { value: string; page: number }[];
      expect(name.value).toBe("Ada Lovelace");
      expect(name.page).toBe(0);
    });
  });

  it("formOrphan carries a field attached to no page", async () => {
    await open("formOrphan", async (handle) => {
      const fields = await handle.doc.getFieldObjects();
      // -1, not undefined and not a valid index: the sentinel `readForm` turns
      // into `page: null` plus AP312 rather than into page 0.
      const [orphan] = fields!.get("orphan") as { page?: number }[];
      expect(orphan.page).toBe(-1);
    });
  });

  it("notAPdf is refused by the parser", async () => {
    await expect(open("notAPdf", async () => undefined)).rejects.toThrow();
  });
});

describe("the document loader", () => {
  it("writes nothing to stdout or stderr, even for a damaged document", async () => {
    // The console capture is what keeps the toolset's own streams clean, and it
    // is the piece most likely to regress silently.
    const written: string[] = [];
    const saved = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = process.stdout.write;
    try {
      await open("damagedXref", async (handle) => {
        await extractPage(handle, 1);
      });
    } finally {
      process.stdout.write = saved.out;
      process.stderr.write = saved.err;
    }
    expect(written).toEqual([]);
  });

  it("restores the console it replaced", async () => {
    const before = console.warn;
    await open("minimal", async () => undefined);
    expect(console.warn).toBe(before);
  });
});
