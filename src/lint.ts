import type { Issue } from "./types.js";
import { checkMarkdownLint } from "./checkers/markdown-lint.js";
import { checkMermaid } from "./checkers/mermaid.js";
import { checkKatex } from "./checkers/katex.js";
import { checkReferences } from "./checkers/references.js";
import { runtime } from "./runtime.js";
import type { MarkdownDocument } from "./workspace.js";

export interface LintFileOptions {
  style?: boolean;
  mermaid?: boolean;
  katex?: boolean;
  references?: boolean;
}

export async function lintFile(
  filePath: string,
  options: LintFileOptions = {},
  document?: MarkdownDocument,
): Promise<Issue[]> {
  const active = runtime();
  const doc = document ?? active.workspace.document(filePath);
  const { content, tree } = doc;
  const issues: Issue[] = [];
  if (options.style) {
    await checkMarkdownLint(filePath, content, issues, active.config.markdownlint.config);
  }
  if (options.mermaid ?? active.config.checks.mermaid) {
    await checkMermaid(filePath, content, issues, tree);
  }
  if (options.katex ?? active.config.checks.katex)
    checkKatex(filePath, content, issues, tree, { macros: active.config.katex.macros });
  if (options.references ?? active.config.checks.references) {
    checkReferences(filePath, content, issues, tree);
  }
  return issues;
}

export function findMarkdownFiles(
  dir: string,
  selection?: { include?: string[]; exclude?: string[] },
): string[] {
  return runtime().workspace.markdownFiles(dir, selection);
}
