import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VIE } from "../src/index.js";
import { fixture } from "./helpers.js";
import { run } from "../src/media/process.js";
describe("ingestion security and bounded processing", () => {
  it("bounds streaming bytes and cleans on cancellation and failed ingestion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vie-ingest-"));
    try {
      const vie = new VIE({ tempDir: dir, maxInputBytes: 4 });
      await expect(
        vie.getMetadata(Readable.from([Buffer.alloc(3), Buffer.alloc(3)])),
      ).rejects.toMatchObject({ code: "BUDGET" });
      expect(await readdir(dir)).toEqual([]);
      const controller = new AbortController();
      const stream = Readable.from(
        (async function* () {
          yield Buffer.from("a");
          controller.abort();
          yield Buffer.from("b");
        })(),
      );
      await expect(
        vie.getMetadata(stream, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects external-reference playlists before FFmpeg can open dependencies", async () => {
    const playlist = Buffer.from(
      "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n",
    );
    await expect(new VIE().getMetadata(playlist)).rejects.toMatchObject({
      code: "MEDIA",
    });
  });
  it("bounds a two-minute video by duration, frames and runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vie-long-"));
    const path = join(dir, "long.mp4");
    try {
      await run(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=red:s=32x32:r=1:d=120",
          "-c:v",
          "libx264",
          "-y",
          path,
        ],
        AbortSignal.timeout(30000),
      );
      const result = await new VIE({
        maxDuration: 2,
        sampling: { mode: "fps", fps: 30, maxFrames: 2 },
        maxRuntimeMs: 30000,
      }).analyze(path);
      expect(result.metadata.duration).toBe(120);
      expect(result.coverage.processedUntil).toBe(2);
      expect(result.coverage.truncated).toBe(true);
      expect(result.frames.length).toBeLessThanOrEqual(2);
      expect(result.frames.every((f) => f.timestamp < 2)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
  it("supports audio-only files while explicitly marking video unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vie-audio-"));
    const path = join(dir, "audio.wav");
    try {
      await run(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=duration=1",
          "-y",
          path,
        ],
        AbortSignal.timeout(10000),
      );
      const result = await new VIE().analyze(path);
      expect(result.frames).toEqual([]);
      expect(result.status.vision).toBe("unavailable");
      expect(result.metadata.audioCodec).toBe("pcm_s16le");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("retains only when explicitly configured and allows caller-owned extraction cleanup", async () => {
    const f = await fixture("mp4", false);
    try {
      const result = await new VIE({
        tempDir: f.dir,
        retain: true,
        sampling: { maxFrames: 1 },
      }).analyze(f.path);
      expect(result.frames[0]!.path).toBeTruthy();
      expect((await readdir(f.dir)).some((n) => n.startsWith("vie-"))).toBe(
        true,
      );
    } finally {
      await f.cleanup();
    }
  }, 30000);
});
