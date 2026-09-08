import path from "node:path";

/**
 * Validators shared by the configuration loader and the script registry parser.
 *
 * These live outside `src/config.ts` so `src/scripts/registry.ts` can reuse them
 * without importing the loader — `config.ts` imports the registry parser to
 * validate a `scripts:` block, and the reverse edge would be a cycle. Keeping
 * `knownKeys` in one place also keeps its message text, which users see and
 * script against, from drifting between the two callers.
 */

export function object(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

export function knownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  name: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown ${name} key: ${unknown}`);
}

export function strings(value: unknown, name: string, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a list of strings`);
  }
  return [...value] as string[];
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

/** True when `target` is `root` itself or lies beneath it. Both must be resolved. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** True when `directory` is inside a node_modules tree, so a vendored config cannot win. */
export function hasNodeModules(directory: string): boolean {
  return directory.split(path.sep).includes("node_modules");
}
