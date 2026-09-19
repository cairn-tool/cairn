import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Deliberately the non-type-checked preset. Type correctness is already enforced by
// `npm run typecheck` (tsc --strict) in its own CI job; layering typescript-eslint's
// type-aware rules on top mostly flags long-standing intentional patterns here —
// uniformly-async commander action handlers, defensive `as unknown as` casts around
// jsdom globals, and `JSON.parse`/YAML values that are genuinely `any` at the boundary.
// This keeps the syntactic rules that catch real mistakes without a type-aware pass.
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      // Fixtures are deliberately malformed markdown, not source
      "tests/fixtures/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Bundle hook handlers. The first JavaScript in `plugins/` — everything else
    // there is Markdown, YAML, or a shell script — so `no-undef` had no Node
    // globals to work from and flagged `process` and `Buffer`. Linted rather
    // than ignored: a handler ships to every host that installs the plugin and
    // runs on every write, which is the last place to want an unchecked typo.
    files: ["plugins/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { process: "readonly", Buffer: "readonly", console: "readonly" },
    },
  },
  {
    // Build scripts. Same story as the hook handlers above: Node modules that
    // `no-undef` has no globals for. `URL` is here because `scripts/codegen.mjs`
    // resolves its own location through `import.meta.url`.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
  prettier,
);
