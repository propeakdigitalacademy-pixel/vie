import {
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  statfs,
  writeFile,
  open,
  access,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, totalmem, arch, cpus } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { secureFetch, boundedBody } from "../security.js";
import { checkAbort, VIEError } from "../errors.js";
export interface ModelManifest {
  id: string;
  name: string;
  url: string;
  bytes: number;
  sha256: string;
  runtime: "whisper.cpp" | "ollama" | "custom";
  minMemoryBytes?: number;
  license: string;
}
export class ModelManager {
  constructor(readonly directory = join(homedir(), ".vie", "models")) {}
  private id(id: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id))
      throw new VIEError("CONFIG", "Invalid model identifier");
    return id;
  }
  hardware() {
    return {
      memoryBytes: totalmem(),
      architecture: arch(),
      cpuCount: cpus().length,
      gpu: "not detected; verify runtime acceleration independently",
    };
  }
  async list(): Promise<ModelManifest[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory);
    const models: ModelManifest[] = [];
    for (const file of entries.filter((f) => f.endsWith(".json"))) {
      try {
        models.push(
          JSON.parse(await readFile(join(this.directory, file), "utf8")),
        );
      } catch {
        throw new VIEError("INSTALL", "Installed model metadata is corrupt");
      }
    }
    return models;
  }
  async inspect(id: string) {
    this.id(id);
    const models = await this.list();
    const manifest = models.find((m) => m.id === id);
    if (!manifest)
      throw new VIEError(
        "MODEL_MISSING",
        "Model is missing; install using a verified manifest or configure an existing runtime",
      );
    const path = join(this.directory, `${id}.model`);
    const { createReadStream } = await import("node:fs");
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
        bytes += chunk.length;
      }
    } catch {
      throw new VIEError(
        "MODEL_MISSING",
        "Installed model artifact is missing",
      );
    }
    if (bytes !== manifest.bytes || hash.digest("hex") !== manifest.sha256)
      throw new VIEError(
        "INSTALL",
        "Installed artifact integrity check failed",
      );
    return { manifest, path };
  }
  async install(
    manifest: ModelManifest,
    options: { confirmed: boolean; signal?: AbortSignal },
  ) {
    this.id(manifest.id);
    if (!options.confirmed)
      throw new VIEError(
        "INSTALL",
        "Explicit confirmation required before model download",
      );
    if (
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.bytes <= 0 ||
      !/^[a-f0-9]{64}$/i.test(manifest.sha256) ||
      !manifest.license ||
      !manifest.name ||
      !["whisper.cpp", "ollama", "custom"].includes(manifest.runtime)
    )
      throw new VIEError(
        "INSTALL",
        "Manifest needs exact bytes, SHA-256, runtime and license",
      );
    if (manifest.minMemoryBytes && manifest.minMemoryBytes > totalmem())
      throw new VIEError(
        "INSTALL",
        "Insufficient system memory for declared model requirement",
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const space = await statfs(this.directory);
    if (space.bavail * space.bsize < manifest.bytes * 1.1)
      throw new VIEError("INSTALL", "Insufficient free storage");
    const temp = join(this.directory, `${randomUUID()}.partial`);
    const lockPath = join(this.directory, `${manifest.id}.lock`);
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      throw new VIEError(
        "INSTALL",
        "Another installation holds this model lock; remove an abandoned lock only after verifying no installer is running",
      );
    }
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(60 * 60 * 1000),
    ]);
    let connection: Awaited<ReturnType<typeof secureFetch>> | undefined;
    let installed = false;
    try {
      const exists = await access(
        join(this.directory, `${manifest.id}.model`),
      ).then(
        () => true,
        () => false,
      );
      if (exists)
        throw new VIEError(
          "INSTALL",
          "Model ID already exists; explicitly remove it before installing a replacement",
        );
      connection = await secureFetch(manifest.url, { signal });
      if (!connection.response.ok)
        throw new VIEError("INSTALL", "Model download failed");
      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, cb) {
          bytes += chunk.length;
          if (bytes > manifest.bytes) {
            cb(new VIEError("INSTALL", "Model exceeded declared size"));
            return;
          }
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(connection.response.body as any),
        meter,
        createWriteStream(temp, { mode: 0o600, flags: "wx" }),
        { signal },
      );
      if (
        bytes !== manifest.bytes ||
        hash.digest("hex") !== manifest.sha256.toLowerCase()
      )
        throw new VIEError("INSTALL", "Model size or SHA-256 mismatch");
      await rename(temp, join(this.directory, `${manifest.id}.model`));
      installed = true;
      // Never persist signed download URLs or credentials in installation metadata.
      await writeFile(
        join(this.directory, `${manifest.id}.json`),
        JSON.stringify({
          id: manifest.id,
          name: manifest.name,
          url: "redacted",
          bytes: manifest.bytes,
          sha256: manifest.sha256.toLowerCase(),
          runtime: manifest.runtime,
          license: manifest.license,
          minMemoryBytes: manifest.minMemoryBytes,
        }),
        { mode: 0o600 },
      );
      return {
        id: manifest.id,
        path: join(this.directory, `${manifest.id}.model`),
        warnings: [
          "Artifact installed, not loaded. Start the declared runtime separately. GPU and performance compatibility are not verified.",
        ],
      };
    } catch (error) {
      if (installed)
        await rm(join(this.directory, `${manifest.id}.model`), { force: true });
      if (installed)
        await rm(join(this.directory, `${manifest.id}.json`), { force: true });
      checkAbort(signal);
      if (error instanceof VIEError) throw error;
      throw new VIEError(
        "INSTALL",
        "Model installation failed; check download endpoint, permissions and available storage",
      );
    } finally {
      await connection?.response.body?.cancel().catch(() => {});
      await connection?.close();
      await rm(temp, { force: true });
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
  async remove(id: string, confirmed = false) {
    this.id(id);
    if (!confirmed)
      throw new VIEError(
        "INSTALL",
        "Explicit confirmation required to remove model",
      );
    await this.inspect(id);
    await rm(join(this.directory, `${id}.model`));
    await rm(join(this.directory, `${id}.json`));
  }
}
export async function runtimeStatus(
  endpoint: string,
  kind: "ollama" | "whisper.cpp",
  signal = AbortSignal.timeout(5000),
) {
  checkAbort(signal);
  const url = new URL(
    kind === "ollama" ? "/api/tags" : "/",
    endpoint,
  ).toString();
  const connection = await secureFetch(url, { local: true, signal });
  try {
    const bytes = await boundedBody(connection.response, 1024 * 1024, signal);
    if (!connection.response.ok)
      throw new VIEError(
        "MODEL_MISSING",
        "Local runtime unavailable; start it and load a model separately",
      );
    return {
      kind,
      available: true,
      models:
        kind === "ollama" ? JSON.parse(bytes.toString()).models : undefined,
      note:
        kind === "whisper.cpp"
          ? "HTTP reachable; loaded model is not verified"
          : "Installed models reported by runtime",
    };
  } finally {
    await connection.close();
  }
}
