// ESLint flat config for the de-invoice backend.
//
// Tier 355: the backend had no eslint at all -- no config, no
// devDependency, no script -- so 245 files / ~82k lines were never
// linted. This mirrors frontend/eslint.config.mjs deliberately: a
// minimal, framework-agnostic setup that catches real bugs and leaves
// style to TypeScript (npx tsc --noEmit) and Prettier.
//
// Type-aware rules (the `projectService` / `recommendedTypeChecked`
// presets) are NOT enabled. They need a full type graph per lint run,
// which on this codebase costs far more than the CI budget for a job
// meant to be fast, and tsc already covers the type dimension in its
// own job.

import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "prisma/migrations/**",
      // Generated Prisma client output, if it ever lands in-tree.
      "src/generated/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: {
        ...globals.node,
        ...globals.jest,
        // TypeScript namespace types, not runtime values: `no-undef`
        // cannot see them through @types/pdfkit and @types/express, the
        // same way the frontend config has to declare `React`. Marked
        // readonly so the rule is satisfied; tsc checks the actual
        // types.
        PDFKit: "readonly",
        Express: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // `no-unused-vars` cannot see TypeScript's type-only bindings,
      // enums or parameter properties, so the base rule is off and the
      // TS-aware one takes over -- same split the frontend config uses.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      // TS's own parser handles overloads and declaration merging;
      // the base rule false-positives on both.
      "no-redeclare": "off",
      "no-dupe-class-members": "off",
      // Same rationale as the frontend: every empty block in this
      // codebase is a deliberate best-effort `catch {}`. Empty
      // non-catch blocks stay an error.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
