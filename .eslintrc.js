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
  plugins: ["node", "prettier", "@typescript-eslint", "mocha", "chai-expect"],
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
        "patterns": [
          { group: ["@ethersproject/bignumber"], message: "Use 'src/utils/BigNumberUtils' instead" },
          { group: ["@ethersproject/contracts"], importNames: ["Event"], message: "Use Log from 'src/interfaces/Common' instead" },
        ],
        "paths": [
          { name: "ethers", importNames: ["BigNumber"], message: "Use 'src/utils/BigNumberUtils' instead" },
          { name: "ethers", importNames: ["Event"], message: "Use Log from 'src/interfaces/Common' instead" }
        ]
      }
    ],
    "@typescript-eslint/no-unused-vars": [
      "error", {
        argsIgnorePattern: "^_",
        ignoreRestSiblings: true
      }
    ],
    "chai-expect/missing-assertion": 2,
    "no-duplicate-imports": "error",
    "require-await": "error",
    "@typescript-eslint/no-floating-promises": ["error"],
  },
};
