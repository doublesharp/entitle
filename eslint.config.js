import js from "@eslint/js";
import babel from "@babel/eslint-parser";

export default [
  { ignores: ["node_modules/**", "dist/**"] },
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: {
      parser: babel,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: [
            [
              "@babel/plugin-syntax-typescript",
              { disallowAmbiguousJSXLike: false },
            ],
          ],
        },
      },
      globals: Object.fromEntries(
        [
          "process",
          "console",
          "Buffer",
          "URL",
          "fetch",
          "setInterval",
          "clearInterval",
          "setTimeout",
          "AbortSignal",
          "document",
          "window",
          "location",
          "navigator",
          "FormData",
          "Headers",
          "Request",
          "Response",
          "localStorage",
        ].map((name) => [name, "readonly"]),
      ),
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
