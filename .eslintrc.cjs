const barrelBackImportMessage =
  "Barrel back-import: this resolves to an index that re-exports the importing module (circular). Import from the defining module instead.";

// Importing "." / "./" / ".." / "../" always targets an index that re-exports the importer.
const restrictedImports = {
  patterns: [
    { group: ["@ethersproject/bignumber"], message: "Use 'src/utils/BigNumberUtils' instead" },
    {
      group: ["@ethersproject/contracts"],
      importNames: ["Event"],
      message: "Use Log from 'src/interfaces/Common' instead",
    },
  ],
  paths: [
    { name: "ethers", importNames: ["BigNumber"], message: "Use 'src/utils/BigNumberUtils' instead" },
    { name: "ethers", importNames: ["Event"], message: "Use Log from 'src/interfaces/Common' instead" },
    { name: ".", message: barrelBackImportMessage },
    { name: "./", message: barrelBackImportMessage },
    { name: "..", message: barrelBackImportMessage },
    { name: "../", message: barrelBackImportMessage },
    { name: "./index", message: barrelBackImportMessage },
    { name: "../index", message: barrelBackImportMessage },
  ],
};

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
    project: "./tsconfig.lint.json",
    include: ["./src/**/*.ts", "./test/**/*.ts", ".eslintrc.js", "./e2e/**/*.ts"],
  },
  plugins: ["prettier", "@typescript-eslint", "mocha", "chai-expect"],
  rules: {
    "prettier/prettier": ["warn"],
    indent: 0, // avoid conflict with prettier's indent system
    "linebreak-style": ["error", "unix"],
    quotes: ["error", "double", { avoidEscape: true }],
    semi: ["error", "always"],
    "spaced-comment": ["error", "always", { exceptions: ["-", "+"] }],
    "no-console": 0,
    "no-restricted-imports": ["error", restrictedImports],
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
      },
    ],
    "chai-expect/missing-assertion": 2,
    "no-duplicate-imports": "error",
    "require-await": "error",
    "@typescript-eslint/no-floating-promises": ["error"],
  },
  overrides: [
    {
      // Inside src/utils, "../utils" is the same barrel back-import spelled via the parent dir.
      files: ["src/utils/**/*.ts"],
      excludedFiles: ["src/utils/index.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            ...restrictedImports,
            paths: [...restrictedImports.paths, { name: "../utils", message: barrelBackImportMessage }],
          },
        ],
      },
    },
    {
      files: ["test/**/*.ts", "e2e/**/*.ts"],
      rules: {
        "@typescript-eslint/no-unused-expressions": "off", // Chai assertions are "unused expressions"
      },
    },
  ],
};
