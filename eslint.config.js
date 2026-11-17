import js from "@eslint/js";
import tseslint from "typescript-eslint";

import mintrail from "./tools/eslint-plugin-mintrail/index.js";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "drizzle/**",
      "coverage/**",
      "tests/parity/.actual/**",
      "docs/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { mintrail },
    rules: {
      "mintrail/no-number-money": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["scripts/**", "**/main-migrate.ts", "tools/**", "sdk-node/examples/**"],
    rules: { "no-console": "off" },
  },
);
