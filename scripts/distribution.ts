import { realpath } from "node:fs/promises";
import { constants } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  open,
  rename,
  readdir,
} from "node:fs/promises";
import { join, dirname, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";

/** Maintainer check only. Packaging still reads the explicit manifest. */
export async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const roots = ["ADDITIONAL-PERMISSION.md", "LICENSE", "NOTICE", "README.md", ".github/CONTRIBUTING.md",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "eslint.config.js",
    "Dockerfile", ".env.example", ".node-version", ".gitignore", ".dockerignore"];
  const walk = async (directory: string) => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["node_modules", "reports", "data", "cache", "dist", "coverage"].includes(entry.name)) continue;
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile() && !/\.(pem|key|p12|env)$/i.test(entry.name)) files.push(relative);
    }
  };
  for (const directory of ["src", "web", "tests", "scripts", "docs", "examples", "deploy"]) await walk(directory);
  return [...roots, ...files].sort();
}

/** Explicit, reviewed source files only. Never walk a deployment's working tree. */
export async function packageSource(root: string, webOutput: string) {
  root = await realpath(root);
  const paths = (await readFile(join(root, "scripts/source-files.txt"), "utf8"))
    .trim()
    .split(/\r?\n/);
  const roots = new Set([
    "ADDITIONAL-PERMISSION.md",
    "LICENSE",
    "NOTICE",
    "README.md",
    ".github/CONTRIBUTING.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "eslint.config.js",
    "Dockerfile",
    ".env.example",
    ".node-version",
    ".gitignore",
    ".dockerignore",
  ]);
  if (new Set(paths).size !== paths.length)
    throw Error("Duplicate source manifest entry");
  for (const path of paths) {
    if (
      (!roots.has(path) &&
        !/^(src|web|tests|scripts|docs|examples|deploy)\/[a-zA-Z0-9_./-]+$/.test(
          path,
        )) ||
      path
        .split("/")
        .some((p) =>
          [
            "..",
            ".",
            "node_modules",
            "reports",
            "data",
            "cache",
            "dist",
            "coverage",
          ].includes(p),
        ) ||
      (basename(path).startsWith(".") && !roots.has(path)) ||
      /\.(pem|key|p12|env)$/i.test(path)
    )
      throw Error("Unsafe source manifest entry");
  }
  const legal = join(webOutput, "legal");
  await mkdir(legal, { recursive: true });
  const stage = await mkdtemp(join(dirname(webOutput), ".source-stage-"));
  try {
    for (const path of paths) {
      if ((await realpath(join(root, path))) !== resolve(root, path))
        throw Error("Symbolic links are forbidden in source manifest");
      const handle = await open(
        join(root, path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if (!(await handle.stat()).isFile())
          throw Error("Source manifest entry is not a regular file");
        const dest = join(stage, path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, await handle.readFile());
      } finally {
        await handle.close();
      }
    }
    const archive = join(legal, "source.tar.gz");
    const result = spawnSync(
      "tar",
      ["-czf", archive + ".new", "-C", stage, ...paths],
      { encoding: "utf8", env: {...process.env, COPYFILE_DISABLE:"1"} },
    );
    if (result.status !== 0) throw Error("Source archive creation failed");
    await rename(archive + ".new", archive);
    await writeFile(
      join(legal, "Elastic-2.0.txt"),
      await readFile(join(root, "LICENSE")),
    );
    await writeFile(
      join(legal, "ADDITIONAL-PERMISSION.txt"),
      await readFile(join(root, "ADDITIONAL-PERMISSION.md")),
    );
    await writeFile(
      join(legal, "0BSD.txt"),
      await readFile(join(root, "examples/GENERATED-CODE-LICENSE")),
    );
    await writeFile(
      join(legal, "MIT.txt"),
      await readFile(join(root, "examples/LICENSE")),
    );
    await writeFile(
      join(legal, "NOTICE.txt"),
      await readFile(join(root, "NOTICE")),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Preserve license text for every npm package whose code enters the browser bundle. */
export async function browserNotices(moduleIds: string[], root: string) {
  const packages = new Set<string>();
  for (const id of [
    ...moduleIds,
    join(root, "node_modules/vite/dist/node/index.js"),
  ]) {
    if (!id.includes("node_modules/") || id.includes("\0")) continue;
    let directory = dirname(resolve(id));
    for (;;) {
      try {
        await readFile(join(directory, "package.json"));
        packages.add(directory);
        break;
      } catch {
        const parent = dirname(directory);
        if (parent === directory)
          throw Error("Bundled dependency has no package metadata");
        directory = parent;
      }
    }
  }
  const { readdir } = await import("node:fs/promises");
  const notices: string[] = [];
  for (const directory of [...packages].sort()) {
    const meta = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { name: string; version: string; license: string };
    const names = (await readdir(directory)).filter((n) =>
      /^(license|copying|notice)(\..*)?$/i.test(n),
    );
    if (!names.length)
      throw Error(`Bundled package ${meta.name} has no license text`);
    notices.push(
      `${meta.name}@${meta.version} (${meta.license})\n` +
        (
          await Promise.all(
            names.map((n) => readFile(join(directory, n), "utf8")),
          )
        ).join("\n"),
    );
  }
  return notices.join("\n\n----------------------------------------\n\n");
}
