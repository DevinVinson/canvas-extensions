import { copyFile, readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const output = resolve(dist, "extension.js");
const files = await readdir(dist, { recursive: true });
if (files.length !== 1 || files[0] !== "extension.js")
  throw new Error(
    `Expected exactly one extension.js, found ${files.join(", ")}`,
  );
const source = await readFile(output, "utf8");
if (!(await stat(output)).size) throw new Error("extension.js is empty");
for (const [pattern, why] of [
  [/(?:^|[;}])\s*import\s*(?:\(|[\s{*])/, "runtime import"],
  [/\bfrom\s*["'](?:\.?\.\/|[A-Za-z@])/, "unresolved import"],
  [/sourceMappingURL=/, "source map"],
  [/\brequire\s*\(/, "CommonJS"],
  [/(?:src|href)\s*=\s*["']https?:/i, "external asset"],
])
  if (pattern.test(source)) throw new Error(`extension.js contains ${why}`);
for (const needle of [
  "activate",
  "ARTIFACT_HANDOFF",
  ".openhands/apps/artifact-handoff",
  "/api/plugins/installed",
  "/launch?plugins=",
  "scripts are disabled",
])
  if (!source.includes(needle)) throw new Error(`extension.js lacks ${needle}`);
if (process.argv.includes("--sync"))
  await copyFile(output, resolve(root, "extension.js"));
console.log(
  "Artifact OK: one self-contained Blob-compatible ESM extension.js.",
);
