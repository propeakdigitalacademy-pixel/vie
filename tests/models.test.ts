import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ReadableStream } from "node:stream/web";
import {
  ModelManager,
  runtimeStatus,
  type ModelManifest,
} from "../src/local/models.js";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("../src/security.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/security.js")>()),
  secureFetch: fetch,
}));
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function manager() {
  const dir = await mkdtemp(join(tmpdir(), "vie-model-"));
  directories.push(dir);
  return new ModelManager(dir);
}
const bytes = Buffer.from("small controlled artifact, not model weights");
const manifest: ModelManifest = {
  id: "tiny",
  name: "Controlled fixture",
  url: "https://example.com/fixture",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  runtime: "custom",
  license: "test-fixture",
};
function download(content = bytes) {
  fetch.mockImplementation(async () => ({
    response: { ok: true, body: ReadableStream.from([content]) },
    close: async () => {},
  }));
}
describe("explicit model lifecycle, no real weights", () => {
  it("never downloads without confirmation or valid manifest", async () => {
    const m = await manager();
    await expect(
      m.install(manifest, { confirmed: false }),
    ).rejects.toMatchObject({ code: "INSTALL" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      m.install({ ...manifest, sha256: "wrong" }, { confirmed: true }),
    ).rejects.toMatchObject({ code: "INSTALL" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("installs, verifies, lists and removes a small controlled artifact", async () => {
    const m = await manager();
    download();
    await m.install(manifest, { confirmed: true });
    await expect(
      m.install(manifest, { confirmed: true }),
    ).rejects.toMatchObject({ code: "INSTALL" });
    expect((await m.list())[0]!.url).toBe("redacted");
    expect((await m.inspect("tiny")).manifest.name).toBe(manifest.name);
    await expect(m.remove("tiny")).rejects.toMatchObject({ code: "INSTALL" });
    await m.remove("tiny", true);
    expect(await m.list()).toEqual([]);
    await expect(m.inspect("tiny")).rejects.toMatchObject({
      code: "MODEL_MISSING",
    });
  });
  it("rejects corrupt size, checksum, path escape and insufficient RAM", async () => {
    const m = await manager();
    download(Buffer.from("corrupt"));
    await expect(
      m.install(manifest, { confirmed: true }),
    ).rejects.toMatchObject({ code: "INSTALL" });
    expect(await readdir(m.directory)).toEqual([]);
    download();
    await expect(
      m.install({ ...manifest, sha256: "0".repeat(64) }, { confirmed: true }),
    ).rejects.toMatchObject({ code: "INSTALL" });
    await expect(
      m.install({ ...manifest, id: "../../escape" }, { confirmed: true }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(
      m.install(
        { ...manifest, minMemoryBytes: Number.MAX_SAFE_INTEGER },
        { confirmed: true },
      ),
    ).rejects.toMatchObject({ code: "INSTALL" });
    await m.install(manifest, { confirmed: true });
    await writeFile(join(m.directory, "tiny.model"), "broken");
    await expect(m.inspect("tiny")).rejects.toMatchObject({ code: "INSTALL" });
  });
  it("reports runtime unavailability without pretending a model is loaded", async () => {
    fetch.mockResolvedValue({
      response: { ok: false, body: ReadableStream.from([Buffer.from("{}")]) },
      close: async () => {},
    });
    await expect(
      runtimeStatus("http://127.0.0.1:8080", "whisper.cpp"),
    ).rejects.toMatchObject({ code: "MODEL_MISSING" });
    fetch.mockResolvedValue({
      response: {
        ok: true,
        body: ReadableStream.from([
          Buffer.from('{"models":[{"name":"existing"}]}'),
        ]),
      },
      close: async () => {},
    });
    expect(
      await runtimeStatus("http://127.0.0.1:11434", "ollama"),
    ).toMatchObject({ available: true, models: [{ name: "existing" }] });
  });
});
