import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { VIE } from "./core/VIE.js";
import { VIEError } from "./errors.js";
import {
  ModelManager,
  runtimeStatus,
  type ModelManifest,
} from "./local/models.js";
import { loadConfig } from "./cli-config.js";
const program = new Command()
  .name("vie")
  .description("Local-first video evidence extraction")
  .version("0.1.0-alpha.1");
program
  .option("-c, --config <path>", "JSON configuration")
  .option("--json", "machine-readable output")
  .option("--model-dir <path>", "model artifact storage");
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
function output(value: unknown) {
  console.log(JSON.stringify(value, null, program.opts().json ? undefined : 2));
}
async function engine() {
  const config = await loadConfig(program.opts().config);
  return new VIE({
    ...config,
    onProgress: program.opts().json
      ? undefined
      : (event) => {
          stderr.write(
            `${event.stage}${event.total !== undefined ? ` ${event.completed ?? 0}/${event.total}` : ""}\n`,
          );
        },
  });
}
const manager = () => new ModelManager(program.opts().modelDir);
async function confirm(message: string, yes?: boolean) {
  if (yes) return true;
  if (!stdin.isTTY)
    throw new VIEError(
      "INSTALL",
      "Interactive confirmation required, or explicitly pass --yes",
    );
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    return (
      (await prompt.question(`${message} Type yes to proceed: `)).trim() ===
      "yes"
    );
  } finally {
    prompt.close();
  }
}
program
  .command("analyze <input>")
  .description("Analyze media; AI disabled unless configured")
  .option("-o, --output <path>", "write analysis JSON")
  .action(async (input, options) => {
    const result = await (
      await engine()
    ).analyze(input, { signal: abort.signal });
    if (options.output)
      await writeFile(options.output, JSON.stringify(result, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
    else output(result);
  });
program
  .command("inspect <input>")
  .description("Read native metadata")
  .action(async (input) =>
    output(await (await engine()).getMetadata(input, { signal: abort.signal })),
  );
program
  .command("models")
  .alias("list")
  .description("List installed model artifacts")
  .action(async () => output(await manager().list()));
program
  .command("install <manifest>")
  .description(
    "Install artifact from a verified JSON manifest (never automatic)",
  )
  .option("--yes", "explicitly approve download")
  .action(async (path, options) => {
    let manifest: ModelManifest;
    try {
      manifest = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new VIEError("INSTALL", "Cannot read model manifest");
    }
    // Do not echo manifest URLs, headers or arbitrary metadata.
    stderr.write(
      `Model: ${String(manifest.name).replace(/[\r\n\x1b]/g, " ")}\nBytes: ${manifest.bytes}\nRequired RAM: ${manifest.minMemoryBytes ?? "unknown"}\nRuntime must be installed separately. GPU compatibility is unverified.\n`,
    );
    output(
      await manager().install(manifest, {
        confirmed: await confirm("Download this artifact?", options.yes),
        signal: abort.signal,
      }),
    );
  });
program
  .command("remove <id>")
  .description("Remove a previously installed model artifact")
  .option("--yes", "explicitly approve removal")
  .action(async (id, options) => {
    await manager().remove(
      id,
      await confirm("Remove this model artifact?", options.yes),
    );
    output({ removed: true });
  });
program
  .command("status")
  .description("Check multimedia tools, hardware and installed artifacts")
  .option("--runtime <url>", "check a loopback runtime")
  .option("--kind <kind>", "ollama or whisper.cpp", "ollama")
  .action(async (options) => {
    if (!["ollama", "whisper.cpp"].includes(options.kind))
      throw new VIEError(
        "CONFIG",
        "Runtime kind must be ollama or whisper.cpp",
      );
    output({
      binaries: await (await engine()).status(abort.signal),
      hardware: manager().hardware(),
      models: await manager().list(),
      runtime: options.runtime
        ? await runtimeStatus(
            options.runtime,
            options.kind,
            AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
          )
        : undefined,
    });
  });
program
  .command("config")
  .description("Validate configuration without printing credentials")
  .action(async () => {
    const vie = await engine();
    output({
      valid: true,
      vision: vie.config.vision.policy,
      transcription: vie.config.transcription.policy,
      sharedFallback: vie.config.sharedFallbackEnabled,
    });
  });
program.parseAsync().catch((error) => {
  const e =
    error instanceof VIEError
      ? error
      : new VIEError(
          "CONFIG",
          "Command failed; check input, permissions and configuration",
        );
  stderr.write(`${e.code}: ${e.message}\n`);
  process.exitCode = e.code === "CANCELLED" ? 130 : 1;
});
