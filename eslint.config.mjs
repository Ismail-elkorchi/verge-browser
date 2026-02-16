import js from "@eslint/js";
import tseslint from "typescript-eslint";

const typedFiles = ["src/**/*.ts"];

const recommendedTypeChecked = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: typedFiles
}));

const strictTypeChecked = tseslint.configs.strictTypeChecked.map((config) => ({
  ...config,
  files: typedFiles
}));

export default [
  {
    ignores: ["dist/**", "node_modules/**", "reports/**", "tmp/**"]
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly"
      }
    }
  },
  ...recommendedTypeChecked,
  ...strictTypeChecked,
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports"
        }
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error"
    }
  }
];
