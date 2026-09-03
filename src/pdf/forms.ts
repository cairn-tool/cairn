import type { OpenDocument } from "./document.js";
import { CODES, DiagnosticSink } from "./diagnostics.js";
import type { PdfDiagnostic, PdfForm, PdfFormField } from "./types.js";

/**
 * AcroForm field inventory.
 *
 * Reads and never writes. Filling a form is manipulation, which the toolset's
 * boundary rules out — `pdf forms` exists because field names and values are
 * frequently the most useful thing in a filled form and a nuisance to get at any
 * other way.
 *
 * Two shapes of the API decide most of this module:
 *
 * `getFieldObjects()` returns a `Map` keyed by fully-qualified field name whose
 * value is an *array*, one entry per widget, because one field can render on
 * several pages. The array is folded here rather than exposed: a consumer wants
 * the field, and the widget count is the only part of the multiplicity that
 * carries information.
 *
 * A field object's `page` is **0-based**, and every other page number in this
 * toolset is 1-based. The conversion happens here, at the boundary, once.
 */

interface FieldObject {
  name?: string;
  type?: string;
  page?: number;
  value?: unknown;
  defaultValue?: unknown;
  editable?: boolean;
  hidden?: boolean;
  password?: boolean;
  charLimit?: number;
  exportValues?: unknown;
}

export interface FormResult {
  form: PdfForm;
  diagnostics: PdfDiagnostic[];
}

/** Field values arrive as strings, names, or arrays; anything else is dropped. */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string");
    return parts.length ? parts.join(", ") : undefined;
  }
  return undefined;
}

function fieldFrom(name: string, widgets: FieldObject[], pageCount: number): PdfFormField {
  // The widgets of one field agree on everything but position, so the first is
  // representative; the count is what the rest contribute.
  const first = widgets[0] ?? {};
  // A field attached to no page reports -1, not undefined — so the range check
  // below is what turns the sentinel into `page: null` instead of page 0.
  const zeroBased = typeof first.page === "number" ? first.page : null;
  const page = zeroBased === null || zeroBased < 0 || zeroBased >= pageCount ? null : zeroBased + 1;
  return {
    name,
    type: typeof first.type === "string" && first.type ? first.type : "unknown",
    page,
    ...(text(first.value) === undefined ? {} : { value: text(first.value) }),
    ...(text(first.defaultValue) === undefined ? {} : { defaultValue: text(first.defaultValue) }),
    readOnly: first.editable === false,
    hidden: first.hidden === true,
    password: first.password === true,
    ...(typeof first.charLimit === "number" && first.charLimit > 0
      ? { charLimit: first.charLimit }
      : {}),
    ...(text(first.exportValues) === undefined ? {} : { exportValues: text(first.exportValues) }),
    widgets: widgets.length,
  };
}

export async function readForm(handle: OpenDocument): Promise<FormResult> {
  const sink = new DiagnosticSink();

  // Checked before the field lookup, not after: an XFA-only document has no
  // AcroForm field objects at all, so an empty list here would otherwise be
  // indistinguishable from a document carrying no form.
  if (handle.doc.isPureXfa) {
    sink.add({
      code: CODES.formXfa,
      quality: "approximate",
      message: "This is an XFA form; its field values live in an XML packet that is not read",
      remediation:
        "Open it in a viewer that supports XFA, or use pdf text for whatever static content the document carries.",
    });
    return { form: { type: "xfa", fieldCount: 0, fields: [] }, diagnostics: sink.all() };
  }

  // Null covers both "no /AcroForm" and "an /AcroForm declaring no fields":
  // pdf.js reports `hasFields: false` for each and there is nothing in the API
  // that separates them, so `none` is the only claim this can honestly make.
  const objects = await handle.within(() => handle.doc.getFieldObjects());
  if (!objects || objects.size === 0)
    return { form: { type: "none", fieldCount: 0, fields: [] }, diagnostics: sink.all() };

  const fields: PdfFormField[] = [];
  for (const [name, widgets] of objects) {
    const list = (Array.isArray(widgets) ? widgets : []) as FieldObject[];
    if (list.length === 0) continue;
    const field = fieldFrom(name, list, handle.doc.numPages);
    if (field.page === null)
      sink.add({
        code: CODES.formFieldPageUnresolved,
        quality: "exact",
        construct: name,
        message: `Field '${name}' does not resolve to a page in this document`,
      });
    fields.push(field);
  }

  // Byte comparison, never localeCompare: a differently configured CI runner
  // would otherwise reorder the payload.
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    form: { type: "acroform", fieldCount: fields.length, fields },
    diagnostics: sink.all(),
  };
}

/** The human and llm rendering: one line per field. */
export function formatForm(form: PdfForm): string {
  if (form.type === "xfa") return "xfa form: field values are not readable\n";
  if (form.fieldCount === 0) return "no form fields\n";
  const width = Math.max(...form.fields.map((field) => field.name.length));
  const lines = form.fields.map((field) => {
    const flags = [
      field.readOnly ? "read-only" : "",
      field.hidden ? "hidden" : "",
      field.password ? "password" : "",
    ].filter(Boolean);
    const page = field.page === null ? "  -" : String(field.page).padStart(3);
    const value = field.value === undefined ? "" : ` = ${JSON.stringify(field.value)}`;
    const suffix = flags.length ? ` [${flags.join(", ")}]` : "";
    return `${page}  ${field.name.padEnd(width)}  ${field.type}${value}${suffix}`;
  });
  return `${lines.join("\n")}\n`;
}
