import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { SCHEMAS, type SchemaId } from "./schemas.js";

// `strict: false` for the same reason every other Ajv call in the cairn estate
// sets it: the schemas carry `title` on `$defs` members, which the generator
// reads as type names and strict mode reads as an unknown keyword in context.
// ajv-formats ships a CommonJS default export, which NodeNext types as a namespace rather than
// a callable. The cast is the same one `src/frontmatter-validation.ts` makes for the same reason.
const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => Ajv2020;
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));

const compiled = new Map<SchemaId, ReturnType<typeof ajv.compile>>();

function validator(id: SchemaId): ReturnType<typeof ajv.compile> {
  const existing = compiled.get(id);
  if (existing) return existing;
  const next = ajv.compile(SCHEMAS[id]);
  compiled.set(id, next);
  return next;
}

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

/** Validates a payload against one of the published artifact schemas. */
export function validate(id: SchemaId, payload: unknown): ValidationResult {
  const validateFn = validator(id);
  const valid = validateFn(payload);
  return { valid: Boolean(valid), errors: validateFn.errors ? [...validateFn.errors] : [] };
}
