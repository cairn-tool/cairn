import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildWorkspaceGraph, focusGraph } from "../../src/graph.js";
import { Workspace } from "../../src/workspace.js";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-graph-"));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
const write = (name: string, content: string) => {
  const file = path.join(directory, name);
  fs.writeFileSync(file, content);
  return file;
};

describe("workspace graph", () => {
  it("aggregates references and reports broken targets, cycles, components, and reachability", () => {
    const a = write("a.md", "[B](b.md) [again](b.md) [self](a.md)\n");
    const b = write("b.md", "[A](a.md) [missing](missing.md)\n");
    const c = write("c.md", "# C\n");
    const workspace = new Workspace(loadConfig({ disabled: true }, directory));
    const graph = buildWorkspaceGraph(workspace, [a, b, c], [a]);
    expect(graph.edges.find((edge) => edge.source === a && edge.target === b)?.occurrences).toBe(2);
    expect(graph.broken).toHaveLength(1);
    expect(graph.cycles).toEqual([[a, b]]);
    expect(graph.components).toHaveLength(2);
    expect(graph.unreachable).toEqual([c]);
    expect(graph.nodes.find((node) => node.file === c)?.deadEnd).toBe(true);
  });

  it("leaves reachability unevaluated without applicable entries and ignores assets", () => {
    const a = write("a.md", "![image](missing.png) [web](https://example.com)\n");
    const workspace = new Workspace(loadConfig({ disabled: true }, directory));
    const graph = buildWorkspaceGraph(workspace, [a], []);
    expect(graph.reachabilityEvaluated).toBe(false);
    expect(graph.unreachable).toEqual([]);
    expect(graph.broken).toEqual([]);
  });
});

describe("focusGraph", () => {
  /** a -> b -> c, plus an isolated d, and e which links *into* b. */
  function chain(): { files: string[]; graph: ReturnType<typeof buildWorkspaceGraph> } {
    const a = write("a.md", "[B](b.md)\n");
    const b = write("b.md", "[C](c.md) [gone](missing.md)\n");
    const c = write("c.md", "# C\n");
    const d = write("d.md", "# D\n");
    const e = write("e.md", "[B](b.md)\n");
    const workspace = new Workspace(loadConfig({ disabled: true }, directory));
    return { files: [a, b, c, d, e], graph: buildWorkspaceGraph(workspace, [a, b, c, d, e], []) };
  }

  it("walks undirected, so a backlink is inside the neighborhood", () => {
    const { files, graph } = chain();
    const [a, b, c, , e] = files;
    const focused = focusGraph(graph, [b], 1);
    // e -> b is an inbound edge; a directed walk from b would miss both it and a.
    expect(focused.nodes.map((node) => node.file).sort()).toEqual([a, b, c, e].sort());
  });

  it("bounds the radius and treats depth 0 as the focus files alone", () => {
    const { files, graph } = chain();
    const [a, b] = files;
    expect(focusGraph(graph, [a], 0).nodes.map((node) => node.file)).toEqual([a]);
    expect(
      focusGraph(graph, [a], 1)
        .nodes.map((node) => node.file)
        .sort(),
    ).toEqual([a, b].sort());
  });

  it("keeps full-graph node counts rather than recomputing them on the subgraph", () => {
    const { files, graph } = chain();
    const [, b] = files;
    const focused = focusGraph(graph, [b], 0);
    // b has one inbound edge from a and one from e, neither of which is drawn.
    expect(focused.nodes[0]).toEqual(graph.nodes.find((node) => node.file === b));
    expect(focused.nodes[0].inbound).toBe(2);
  });

  it("keeps only edges with both endpoints in the neighborhood", () => {
    const { files, graph } = chain();
    const [a, b] = files;
    const focused = focusGraph(graph, [a], 1);
    expect(focused.edges.map((edge) => [edge.source, edge.target])).toEqual([[a, b]]);
  });

  it("reports broken targets by source and never fabricates one for a link leaving the radius", () => {
    const { files, graph } = chain();
    const [a, b] = files;
    // b -> c leaves the depth-0 neighborhood of b but is a resolved edge, not broken.
    expect(focusGraph(graph, [b], 0).broken.map((edge) => edge.target)).toEqual(["missing.md"]);
    expect(focusGraph(graph, [a], 0).broken).toEqual([]);
  });

  it("keeps a component whole when any member is in focus", () => {
    const { files, graph } = chain();
    const [a, b, c, d] = files;
    // Truncating would turn a multi-document component into a misleading singleton.
    const focused = focusGraph(graph, [b], 0);
    expect(focused.components).toEqual([graph.components.find((group) => group.includes(a))]);
    expect(focused.components[0]).toContain(c);
    expect(focused.components.flat()).not.toContain(d);
  });

  it("ignores a focus file that is not a node", () => {
    const { graph } = chain();
    expect(focusGraph(graph, [path.join(directory, "nope.md")], 2).nodes).toEqual([]);
  });
});
