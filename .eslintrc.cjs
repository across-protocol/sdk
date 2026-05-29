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
    "no-restricted-imports": [
      "error",
      {
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
        ],
      },
    ],
    // Block named imports from CJS-only deps. Under Node ESM the named
    // import fails with "Named export 'X' not found" because
    // cjs-module-lexer can't statically detect the exports. AST selectors
    // (rather than no-restricted-imports.importNames) so namespace and
    // type-only imports are still allowed — only runtime named imports
    // are blocked.
    "no-restricted-syntax": [
      "error",
      {
        selector:
          "ImportDeclaration[importKind!='type'][source.value='lodash'] > ImportSpecifier[importKind!='type']",
        message:
          "lodash is CJS-only under Node ESM. Use `import lodash from 'lodash'; const { ... } = lodash;` instead.",
      },
      {
        selector:
          "ImportDeclaration[importKind!='type'][source.value='@coral-xyz/anchor'] > ImportSpecifier[importKind!='type']",
        message:
          "@coral-xyz/anchor's browser ESM has no default export but its Node CJS path needs default-interop. Use `import * as anchorModule from '@coral-xyz/anchor'; const anchor = anchorModule.default ?? anchorModule; const { ... } = anchor;` instead.",
      },
    ],
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
      files: ["test/**/*.ts", "e2e/**/*.ts"],
      rules: {
        "@typescript-eslint/no-unused-expressions": "off", // Chai assertions are "unused expressions"
      },
    },
  ],
};
