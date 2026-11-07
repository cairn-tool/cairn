import katex from "katex";
import type { Issue } from "../types.js";
import { parseMarkdown, extractCodeBlocks, isLineInCodeBlock, type Root } from "../markdown-ast.js";

/** What the math check renders with besides its fixed strictness: the project's `katex.macros`. */
export interface KatexOptions {
  macros?: Readonly<Record<string, string>>;
}

function validateKatexExpression(
  filePath: string,
  lineNum: number,
  expr: string,
  displayMode: boolean,
  issues: Issue[],
  options: KatexOptions,
): void {
  if (!expr.trim()) return;
  try {
    katex.renderToString(expr, {
      throwOnError: true,
      strict: "error",
      displayMode,
      // A fresh copy each time: KaTeX writes `\gdef`s into the object it is given, and one
      // expression's definitions must not leak into the next one's check.
      ...(options.macros ? { macros: { ...options.macros } } : {}),
    });
  } catch (err) {
    issues.push({
      file: filePath,
      line: lineNum,
      checker: "katex",
      message: `Invalid ${displayMode ? "display" : "inline"} math: ${(err as Error).message}`,
    });
  }
}

export function checkKatex(
  filePath: string,
  content: string,
  issues: Issue[],
  tree?: Root,
  options: KatexOptions = {},
): void {
  const parsedTree = tree ?? parseMarkdown(content);
  const codeBlocks = extractCodeBlocks(parsedTree);
  const lines = content.split("\n");

  let inDisplayMath = false;
  let displayMathStart = 0;
  let displayMathBuffer = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (isLineInCodeBlock(lineNum, codeBlocks)) continue;

    // Handle display math blocks ($$...$$)
    if (inDisplayMath) {
      if (line.includes("$$")) {
        displayMathBuffer += "\n" + line.substring(0, line.indexOf("$$"));
        validateKatexExpression(
          filePath,
          displayMathStart,
          displayMathBuffer.trim(),
          true,
          issues,
          options,
        );
        inDisplayMath = false;
        displayMathBuffer = "";
      } else {
        displayMathBuffer += "\n" + line;
      }
      continue;
    }

    // Check for display math start
    const displayStart = line.indexOf("$$");
    if (displayStart !== -1) {
      const afterStart = line.substring(displayStart + 2);
      const displayEnd = afterStart.indexOf("$$");
      if (displayEnd !== -1) {
        const expr = afterStart.substring(0, displayEnd);
        validateKatexExpression(filePath, lineNum, expr, true, issues, options);
      } else {
        inDisplayMath = true;
        displayMathStart = lineNum;
        displayMathBuffer = afterStart;
      }
      continue;
    }

    // Check for inline math ($...$) — avoid matching escaped \$ and $$
    const inlineRe = /(?<![\\$])\$(?!\$)(.+?)(?<![\\$])\$/g;
    let inlineMatch;
    while ((inlineMatch = inlineRe.exec(line)) !== null) {
      validateKatexExpression(filePath, lineNum, inlineMatch[1], false, issues, options);
    }
  }
}
