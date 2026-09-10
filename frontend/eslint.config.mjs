// ESLint flat config for the de-invoice frontend.
//
// eslint-config-next 15.x is legacy-only and not
// compatible with the flat config that ESLint v9
// uses by default. So this config is a minimal,
// framework-agnostic setup that catches the most
// common bugs without forcing the team onto a
// specific framework's style rules. Heavier
// style enforcement is intentionally left to
// TypeScript (npx tsc --noEmit) and Prettier
// (separate).
//
// If eslint-config-next 16+ adds flat-config
// support, swap the import back. As of 2026-09-06,
// eslint-config-next 15.x is legacy-only.

import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "next-env.d.ts",
      "playwright/**",
      "test-results/**",
      "scripts/**",
    ],
  },
  js.configs.recommended,
  // Default parser = TypeScript for all .ts/.tsx/.js.
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        // React is a namespace, not a runtime value.
        // `no-undef` can't see it through @types/react.
        // Mark as readonly so the rule is satisfied
        // (the React.* types are checked by tsc).
        React: "readonly",
        // DOM type-only globals (RequestInit, BodyInit
        // are TypeScript types, not runtime values,
        // so globals.browser doesn't list them).
        RequestInit: "readonly",
        BodyInit: "readonly",
        ResponseInit: "readonly",
        RequestInfo: "readonly",
        // Playwright / test runner
        test: "readonly",
        expect: "readonly",
        page: "readonly",
        context: "readonly",
        browser: "readonly",
        // Node.js (some frontend scripts touch)
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          // `caughtErrors: 'none'` keeps the v5-and-earlier
          // default: catch (err) doesn't have to reference
          // err. This avoids false-positives on the dozens
          // of catch blocks that just call toast.error(...)
          // with a static message. (Tier 322.)
          caughtErrors: "none",
          // Tier 349: `const { selfHash, ...rest } = manifest`
          // is the standard omit-a-key idiom -- selfHash is
          // destructured precisely so it is NOT in `rest`, and
          // is unused by design. gobd-export-tier166 and
          // datev-buchungsliste-tier167 both do it when
          // rebuilding a BSI TR-03127 preimage.
          ignoreRestSiblings: true,
          // A leading underscore marks a binding kept for
          // shape/documentation but deliberately unread --
          // same convention argsIgnorePattern already applies
          // to parameters.
          varsIgnorePattern: "^_",
        },
      ],
      // Tier 349: allow `catch {}`. All 29 empty blocks in
      // the suite are catch blocks, and every one is a
      // deliberate best-effort idiom -- either
      // `try { data = await res.json() } catch {}` (the
      // response may not be JSON; leaving data null IS the
      // handling) or
      // `try { unlinkSync(tmp) } catch {}` in a finally
      // (temp-file cleanup must not mask the real assertion
      // failure). Empty non-catch blocks stay an error.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-redeclare": "off", // false-positive on
                              // import-comment lines
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // @next/next/* rules require eslint-plugin-next,
      // which is shipped only via eslint-config-next
      // (legacy format, not flat-config-compatible in
      // 15.x). Disable the eslint-disable references
      // until we have a flat-config Next.js preset.
      "@next/next/no-img-element": "off",
    },
  },
];
