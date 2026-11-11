import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, chmod, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { VideoInput } from "../types.js";
import { checkAbort, VIEError } from "../errors.js";
import { secureFetch } from "../security.js";

export async function ingest(
  input: VideoInput,
  config: Config,
  signal: AbortSignal,
) {
  const dir = await mkdtemp(join(config.tempDir ?? tmpdir(), "vie-"));
  await chmod(dir, 0o700);
  const path = join(dir, "input.media");
  let network: Awaited<ReturnType<typeof secureFetch>> | undefined;
  try {
    checkAbort(signal);
    let source: Readable;
    if (typeof input === "string") {
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
        if (!config.allowRemote)
          throw new VIEError(
            "INPUT",
            "Remote input is disabled; explicitly set allowRemote",
          );
        network = await secureFetch(input, { signal });
        if (!network.response.ok)
          throw new VIEError("INPUT", "Remote input download failed");
        source = Readable.fromWeb(network.response.body as any);
      } else {
        const original = resolve(input);
        const info = await stat(original).catch(() => {
          throw new VIEError("INPUT", "Input file not found");
        });
        if (!info.isFile())
          throw new VIEError("INPUT", "Input must be a regular file");
        if (info.size > config.maxInputBytes)
          throw new VIEError("BUDGET", "Input exceeds byte limit");
        source = createReadStream(original);
      }
    } else if (Buffer.isBuffer(input)) source = Readable.from([input]);
    else if (input instanceof Blob)
      source = Readable.fromWeb(input.stream() as any);
    else if (input instanceof Readable) source = input;
    else
      throw new VIEError(
        "INPUT",
        "Expected a path, Buffer, Blob/File or Node readable stream",
      );
    let bytes = 0;
    const hash = createHash("sha256");
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > config.maxInputBytes) {
          callback(new VIEError("BUDGET", "Input exceeds byte limit"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      source,
      meter,
      createWriteStream(path, { mode: 0o600, flags: "wx" }),
      { signal },
    );
    if (!bytes) throw new VIEError("INPUT", "Input is empty");
    return {
      dir,
      path,
      hash: hash.digest("hex"),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    checkAbort(signal);
    throw error;
  } finally {
    await network?.response.body?.cancel().catch(() => {});
    await network?.close();
  }
}
