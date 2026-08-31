import { CODES, DiagnosticSink } from "./diagnostics.js";
import { CONTENT_MODEL, FIDELITY, MARK_FIDELITY, PANEL_TYPES, accepts } from "./profile.js";
import type { AdfDocument, AdfNode, ConversionDiagnostic } from "./types.js";

/**
 * Structural validation against this tool's own content model.
 *
 * Deliberately not a wrapper around Atlassian's schema. That schema is a
 * devDependency read only by `tests/unit/jira-adf-profile.test.ts`, which proves the
 * model here agrees with it in both directions — so this reports the same
 * legality answers without shipping someone else's document, and a node type the
 * model does not know reports `AD100` rather than pretending to be Atlassian's
 * validator. It is the same line `agent test --native` draws: every target
 * profile declares `nativeValidator: null` and publishes the command to run
 * yourself.
 */

function attributeError(
  node: AdfNode,
  sink: DiagnosticSink,
  trail: string[],
  message: string,
): void {
  sink.add({
    code: CODES.badAttribute,
    quality: "unsupported",
    severity: "error",
    message,
    node: node.type,
    location: trail.join("/"),
  });
}

function checkAttributes(node: AdfNode, sink: DiagnosticSink, trail: string[]): void {
  switch (node.type) {
    case "heading": {
      const level = node.attrs?.level;
      if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 6)
        attributeError(
          node,
          sink,
          trail,
          `heading level must be an integer 1-6, got ${String(level)}`,
        );
      break;
    }
    case "panel": {
      const kind = node.attrs?.panelType;
      if (typeof kind !== "string" || !PANEL_TYPES.has(kind))
        attributeError(
          node,
          sink,
          trail,
          `panelType must be one of ${[...PANEL_TYPES].join(", ")}, got ${String(kind)}`,
        );
      break;
    }
    case "taskList":
    case "taskItem":
    case "decisionList":
    case "decisionItem": {
      if (typeof node.attrs?.localId !== "string")
        attributeError(node, sink, trail, `${node.type} requires a string localId`);
      break;
    }
    case "media": {
      const kind = node.attrs?.type;
      if (kind === "external") {
        if (typeof node.attrs?.url !== "string")
          attributeError(node, sink, trail, "external media requires a url");
      } else if (kind === "file" || kind === "link") {
        if (typeof node.attrs?.id !== "string")
          attributeError(node, sink, trail, `${String(kind)} media requires an id`);
        if (typeof node.attrs?.collection !== "string")
          attributeError(node, sink, trail, `${String(kind)} media requires a collection`);
      } else {
        attributeError(
          node,
          sink,
          trail,
          `media type must be external, file, or link, got ${String(kind)}`,
        );
      }
      break;
    }
    case "text": {
      // An empty text node is invalid ADF, which is why an empty paragraph is
      // `content: []` rather than a paragraph holding empty text.
      if (node.text === "")
        attributeError(node, sink, trail, "a text node may not carry an empty string");
      break;
    }
    default:
      break;
  }
}

function walk(node: AdfNode, sink: DiagnosticSink, trail: string[]): void {
  const here = [...trail, node.type];

  if (!FIDELITY[node.type]) {
    sink.add({
      code: CODES.unknownNode,
      quality: "unsupported",
      message: `Unrecognized ADF node type '${node.type}'`,
      node: node.type,
      location: trail.join("/"),
      remediation:
        "This tool's content model does not know this node, so it cannot be validated or converted. Check for a newer cairn.",
    });
    return;
  }

  checkAttributes(node, sink, trail);

  for (const mark of node.marks ?? []) {
    if (MARK_FIDELITY[mark.type]) continue;
    sink.add({
      code: CODES.unknownMark,
      quality: "unsupported",
      message: `Unrecognized ADF mark '${mark.type}'`,
      node: mark.type,
      location: here.join("/"),
    });
  }
  // Code block text carries no marks: the schema forbids it outright.
  if (node.type === "codeBlock")
    for (const child of node.content ?? [])
      if (child.marks?.length)
        sink.add({
          code: CODES.illegalContent,
          quality: "unsupported",
          severity: "error",
          message: "Text inside a code block may not carry marks",
          node: "text",
          location: here.join("/"),
        });

  const rule = CONTENT_MODEL[node.type];
  const children = node.content ?? [];

  if (rule) {
    if (children.length < rule.minimum)
      sink.add({
        code: CODES.missingContent,
        quality: "unsupported",
        severity: "error",
        message: `${node.type} requires at least ${rule.minimum} child, but has ${children.length}`,
        node: node.type,
        location: trail.join("/"),
      });
    if (rule.maximum !== undefined && children.length > rule.maximum)
      sink.add({
        code: CODES.illegalContent,
        quality: "unsupported",
        severity: "error",
        message: `${node.type} allows at most ${rule.maximum} child, but has ${children.length}`,
        node: node.type,
        location: trail.join("/"),
      });
    for (const child of children)
      if (!accepts(node.type, child.type))
        sink.add({
          code: CODES.illegalContent,
          quality: "unsupported",
          severity: "error",
          message: `ADF does not allow ${child.type} inside ${node.type}`,
          node: child.type,
          location: here.join("/"),
        });
  }

  for (const child of children) walk(child, sink, here);
}

export interface ValidateResult {
  diagnostics: ConversionDiagnostic[];
  /** Node and mark types the content model does not know. */
  unknown: string[];
}

export function validateAdf(document: AdfDocument): ValidateResult {
  const sink = new DiagnosticSink();
  const rule = CONTENT_MODEL.doc;
  const children = document.content ?? [];
  for (const child of children)
    if (!accepts("doc", child.type) && FIDELITY[child.type])
      sink.add({
        code: CODES.illegalContent,
        quality: "unsupported",
        severity: "error",
        message: `ADF does not allow ${child.type} at the top level of a document`,
        node: child.type,
        location: "doc",
      });
  if (children.length < rule.minimum)
    sink.add({
      code: CODES.missingContent,
      quality: "unsupported",
      severity: "error",
      message: "A document requires content",
      node: "doc",
      location: "doc",
    });
  for (const child of children) walk(child, sink, ["doc"]);

  const diagnostics = sink.all();
  const unknown = [
    ...new Set(
      diagnostics
        .filter((item) => item.code === CODES.unknownNode || item.code === CODES.unknownMark)
        .map((item) => item.node ?? ""),
    ),
  ]
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { diagnostics, unknown };
}
