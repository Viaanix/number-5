import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    useTabs: false,
    tabWidth: 2,
    printWidth: 100,
    singleQuote: false,
    jsxSingleQuote: false,
    quoteProps: "as-needed",
    trailingComma: "all",
    semi: true,
    arrowParens: "always",
    bracketSameLine: false,
    bracketSpacing: true,
    sortImports: true,
    ignorePatterns: [
      "**/node_modules",
      "**/bun.lock",
      ".claude",
      "**/*.md",
      "**/*.yaml",
      "**/*.yml",
    ],
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "import"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    rules: {
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "prefer-const": "error",
      "typescript/no-misused-promises": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/only-throw-error": "error",
      "typescript/prefer-promise-reject-errors": "error",
      "typescript/require-await": "error",
      "typescript/restrict-plus-operands": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/no-deprecated": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    ignorePatterns: ["node_modules", ".claude"],
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
});
