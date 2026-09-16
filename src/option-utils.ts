/**
 * Accumulator for repeatable options. `src/contract/walk-options.ts` detects
 * repeatability by comparing an option's coercion against this function by
 * identity, so it must not be wrapped at registration sites.
 */
export function collect(val: string, acc: string[] = []): string[] {
  acc.push(val);
  return acc;
}

/**
 * Parses a non-negative integer option, with an optional inclusive maximum.
 *
 * Shared so that `--depth` means the same thing, and fails with the same
 * message, wherever it appears.
 */
export function boundedInteger(value: string, name: string, max?: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || (max !== undefined && parsed > max)) {
    throw new Error(
      max === undefined
        ? `--${name} must be a non-negative integer`
        : `--${name} must be an integer from 0 to ${max}`,
    );
  }
  return parsed;
}
