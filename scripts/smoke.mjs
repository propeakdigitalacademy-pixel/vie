import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function command(binary, args, cwd = root) {
  // npm.cmd requires Windows command dispatch; arguments here are controlled, not media input.
  return execFileSync(binary, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && binary.endsWith(".cmd"),
  });
}
const dir = mkdtempSync(join(tmpdir(), "vie-install-"));
const output = resolve("generated-artifacts");
mkdirSync(output, { recursive: true });
try {
  const packed = JSON.parse(
    command(npm, ["pack", "--json", "--pack-destination", output]),
  )[0];
  const names = packed.files.map((f) => f.path);
  const markdown = names.filter((name) => name.endsWith(".md")).sort();
  if (
    JSON.stringify(markdown) !== JSON.stringify(["CHANGELOG.md", "README.md"])
  )
    throw new Error(
      "Package must contain exactly README.md and CHANGELOG.md as Markdown documentation",
    );
  if (
    !names.includes("LICENSE") ||
    names.some((name) => name.startsWith("docs/"))
  )
    throw new Error(
      "Missing proprietary LICENSE or obsolete documentation directory in package",
    );
  if (
    names.some((n) =>
      /^(src|tests|node_modules|attached_assets|\.agents|\.env)(\/|$)/.test(n),
    )
  )
    throw new Error("Unexpected private/development package content");
  if (names.some((n) => /\.model$|\.bin$|\.gguf$/.test(n)))
    throw new Error("Model weights in package");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "vie-clean-install-test",
      private: true,
      type: "module",
    }),
  );
  command(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(output, packed.filename),
    ],
    dir,
  );
  command(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { VIE } from 'vie-engine'; if (typeof new VIE().analyze !== 'function') throw Error('ESM export failed')",
    ],
    dir,
  );
  command(
    process.execPath,
    [
      "-e",
      "const { VIE } = require('vie-engine'); if (typeof new VIE().analyze !== 'function') throw Error('CJS export failed')",
    ],
    dir,
  );
  command(
    process.execPath,
    [join(dir, "node_modules", "vie-engine", "dist", "cli.js"), "--help"],
    dir,
  );
  // Call the installed executable shim as well as the JS entry.
  command(
    process.platform === "win32"
      ? join(dir, "node_modules", ".bin", "vie.cmd")
      : join(dir, "node_modules", ".bin", "vie"),
    ["--help"],
    dir,
  );
  const video = join(dir, "synthetic.mp4");
  command(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:s=64x64:d=0.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    dir,
  );
  const result = JSON.parse(
    command(
      process.execPath,
      [
        join(dir, "node_modules", "vie-engine", "dist", "cli.js"),
        "--json",
        "analyze",
        video,
      ],
      dir,
    ),
  );
  if (
    result.schemaVersion !== "1.0" ||
    !result.frames.length ||
    result.status.vision !== "disabled"
  )
    throw Error("Installed native analysis failed");
  const manifest = JSON.parse(
    readFileSync(
      join(dir, "node_modules", "vie-engine", "package.json"),
      "utf8",
    ),
  );
  if (manifest.scripts?.postinstall)
    throw Error("Unexpected installation hook");
  console.log(
    JSON.stringify(
      {
        node: process.version,
        esm: true,
        cjs: true,
        installedCLI: true,
        nativeAnalysis: true,
        files: packed.entryCount,
        unpackedBytes: packed.unpackedSize,
        tarball: packed.filename,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
