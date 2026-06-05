/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { project: false, ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint", "react-hooks"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/consistent-type-imports": "error",
    "no-console": ["error", { allow: ["warn", "error"] }],
    // react-hooks/exhaustive-deps is referenced inline as eslint-disable
    // comments across the admin app; keep it as a warning so those
    // comments are honoured but new violations don't break the build.
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn"
  },
  ignorePatterns: ["dist", "node_modules", "migrations", "*.config.*"]
};
