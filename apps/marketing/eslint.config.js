import js from "@eslint/js";
import babel from "@babel/eslint-parser";
import { createRequire } from "node:module";

const typescriptSyntax = createRequire(import.meta.url).resolve(
  "@babel/plugin-syntax-typescript",
);

// Resolve tooling from the web package so a filtered install needs no root deps.
export default [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: babel,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: [[typescriptSyntax, { disallowAmbiguousJSXLike: false }]],
        },
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
