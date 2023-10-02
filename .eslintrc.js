module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:prettier/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    project: "./tsconfig.json",
    include: ["./src/**/*.ts", "./test/**/*.ts", ".eslintrc.js"],
  },
  plugins: ["node", "prettier", "@typescript-eslint", "mocha", "chai-expect"],
  rules: {
    "prettier/prettier": ["warn"],
    indent: 0, // avoid conflict with prettier's indent system
    "linebreak-style": ["error", "unix"],
    quotes: ["error", "double", { avoidEscape: true }],
    semi: ["error", "always"],
    "spaced-comment": ["error", "always", { exceptions: ["-", "+"] }],
    "no-console": 0,
    "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    "chai-expect/missing-assertion": 2,
    "no-duplicate-imports": "error",
    "require-await": "error",
    "@typescript-eslint/no-floating-promises": ["error"],
  },
};
