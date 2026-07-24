// @ts-check
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import promisePlugin from "eslint-plugin-promise";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["./tsconfig.eslint.json", "./tsconfig.client.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      promise: promisePlugin,
    },
    rules: {
      // No explicit `any`
      "@typescript-eslint/no-explicit-any": "error",

      // No unsafe operations (requires type info)
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // No floating promises
      "@typescript-eslint/no-floating-promises": "error",

      // Exhaustive switch/case checks. considerDefaultExhaustiveForUnions treats
      // a `default:` clause as covering the remaining union members (used by
      // matchApi's core/logistics intent split and server/logistics/dispatch.ts's
      // isLogisticsIntent guard, both of which deliberately dispatch the "rest" of the Intent union
      // to a default branch rather than listing every case).
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],

      // Cyclomatic complexity cap
      complexity: ["warn", { max: 10 }],

      // Function length cap
      "max-lines-per-function": ["warn", { max: 60, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Test files: long describe/it callbacks are idiomatic — relax size/complexity caps.
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "max-lines-per-function": "off",
      complexity: "off",
    },
  },
];
