import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const clone = mkdtempSync(join(tmpdir(), "vie-public-clone-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const options = {
  cwd: clone,
  stdio: "inherit",
  shell: process.platform === "win32",
};
try {
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsup.config.ts",
    "eslint.config.js",
    "src",
    "tests",
    "scripts",
    "examples",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "release-readiness.json",
  ])
    cpSync(resolve(path), join(clone, path), { recursive: true });
  // A fresh cache prevents an existing Replit cache from concealing inaccessible URLs.
  execFileSync(
    npm,
    [
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      `--cache=${join(clone, ".fresh-cache")}`,
    ],
    options,
  );
  execFileSync(npm, ["run", "check"], options);
  console.log(
    "Public-registry clean clone installed, checked, built and passed SDK/CLI smoke tests.",
  );
} finally {
  rmSync(clone, { recursive: true, force: true });
}
