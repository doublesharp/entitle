import { z } from "zod";
export const frameworks = [
  "wordpress",
  "joomla",
  "electron",
  "tauri",
  "sparkle",
  "jetbrains",
  "generic",
] as const;
export type Framework = (typeof frameworks)[number];
const identity = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const build = z
  .string()
  .max(60)
  .regex(/^\d+(?:\.\d+)*(?:\.\*)?$/);
const empty = z.object({}).strict();
const configurations = {
  wordpress: empty,
  electron: empty,
  tauri: empty,
  sparkle: empty,
  joomla: z
    .object({
      extensionType: z.enum([
        "plugin",
        "component",
        "module",
        "template",
        "package",
        "library",
      ]),
      element: identity,
      folder: identity.optional(),
      client: z.enum(["site", "administrator"]).optional(),
      joomlaMajor: z.number().int().min(3).max(99),
    })
    .strict()
    .refine(
      (v) => v.extensionType !== "plugin" || v.folder !== undefined,
      "Joomla plugins require a folder.",
    )
    .refine(
      (v) =>
        !["module", "template", "library", "package"].includes(
          v.extensionType,
        ) || v.client !== undefined,
      "Joomla modules, templates, libraries and packages require an explicit client.",
    ),
  jetbrains: z
    .object({
      pluginId: identity,
      sinceBuild: z
        .string()
        .max(60)
        .regex(/^\d+(?:\.\d+)*$/),
      untilBuild: build.optional(),
    })
    .strict(),
  generic: z
    .object({ activationKind: z.enum(["site", "device"]).optional() })
    .strict(),
};
export type FrameworkConfig = z.infer<(typeof configurations)[Framework]>;
export function validateFramework(value: unknown): Framework {
  return z.enum(frameworks).parse(value);
}
export function validateFrameworkConfig(
  framework: Framework,
  value: unknown = {},
): FrameworkConfig {
  return configurations[framework].parse(value);
}
export function activationKind(
  framework: Framework,
  config: FrameworkConfig,
): "site" | "device" {
  return framework === "wordpress" ||
    framework === "joomla" ||
    (framework === "generic" &&
      "activationKind" in config &&
      config.activationKind === "site")
    ? "site"
    : "device";
}

export const frameworkTargets = {
  wordpress: [],
  joomla: ["any"],
  jetbrains: ["any"],
  electron: [
    "windows-x64",
    "windows-arm64",
    "darwin-x64",
    "darwin-arm64",
    "linux-x64",
    "linux-arm64",
  ],
  tauri: [
    "windows-x86_64",
    "windows-aarch64",
    "windows-i686",
    "darwin-x86_64",
    "darwin-aarch64",
    "linux-x86_64",
    "linux-aarch64",
    "linux-i686",
    "linux-armv7",
  ],
  sparkle: ["darwin-x64", "darwin-arm64", "darwin-universal"],
  generic: [],
} as const;
