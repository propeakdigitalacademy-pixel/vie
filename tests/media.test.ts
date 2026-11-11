import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { VIE } from "../src/index.js";
import { fixture, provider } from "./helpers.js";
describe("real FFmpeg media", () => {
  it.each(["mp4", "mov", "mkv", "webm"])(
    "processes %s with aligned source evidence",
    async (ext) => {
      const f = await fixture(ext);
      try {
        const vie = new VIE({
          sampling: {
            mode: "custom",
            timestamps: [0, 0.5, 1, 1.5],
            maxFrames: 4,
          },
          maxDuration: 3,
        });
        const meta = await vie.getMetadata(f.path);
        expect(meta.duration).toBeCloseTo(2, 1);
        expect(meta.width).toBe(160);
        expect(meta.audioCodec).toBeTruthy();
        const result = await vie.analyze(f.path);
        expect(result.scenes.length).toBe(2);
        expect(result.scenes[1]!.start).toBeCloseTo(1, 1);
        expect(result.frames).toHaveLength(4);
        expect(result.frames[1]!.timestamp).toBeCloseTo(0.5, 1);
        expect(result.frames.every((f) => !f.path)).toBe(true);
        expect(result.status.vision).toBe("disabled");
        expect(result.coverage.visualGaps.length).toBeGreaterThan(0);
        const audio = await vie.extractAudio(f.path);
        expect((await stat(audio.path)).size).toBeGreaterThan(100);
        await audio.cleanup();
        const frame = await vie.getFrame(f.path, 1);
        expect((await stat(frame.frame.path!)).size).toBeGreaterThan(0);
        await frame.cleanup();
      } finally {
        await f.cleanup();
      }
    },
    30000,
  );
  it("accepts Buffer, stream, Blob and File without touching original", async () => {
    const f = await fixture("mp4", false);
    try {
      const bytes = await readFile(f.path);
      const vie = new VIE();
      for (const input of [
        bytes,
        Readable.from([bytes]),
        new Blob([new Uint8Array(bytes)]),
        new File([new Uint8Array(bytes)], "video.mp4"),
      ])
        expect((await vie.getMetadata(input)).duration).toBeCloseTo(2);
      expect((await stat(f.path)).size).toBe(bytes.length);
      await expect(vie.extractAudio(f.path)).rejects.toMatchObject({
        code: "MEDIA",
      });
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it.each([
    { width: 64, height: 192, fps: 24, duration: 0.25 },
    { width: 320, height: 64, fps: 7, duration: 3 },
  ])(
    "handles short and unusual geometry %j",
    async (options) => {
      const f = await fixture("mp4", false, options);
      try {
        const result = await new VIE({
          sampling: { maxFrames: 1 },
          maxDuration: 1,
        }).analyze(f.path);
        expect(result.frames).toHaveLength(1);
        expect(result.coverage.processedUntil).toBeLessThanOrEqual(1);
      } finally {
        await f.cleanup();
      }
    },
    30000,
  );
  it("reports provider partial failure, offsets chunked transcription and cleans private media", async () => {
    const f = await fixture();
    const temp = join(f.dir, "temp");
    await import("node:fs/promises").then((fs) => fs.mkdir(temp));
    try {
      const vie = new VIE({
        tempDir: temp,
        sampling: { maxFrames: 2, interval: 1 },
        audioChunkSeconds: 1,
        transcription: {
          providers: [provider("speech", undefined, "transcription")],
        },
        vision: {
          providers: [
            provider("bad", async () => {
              throw new Error("private-key-must-not-appear");
            }),
          ],
        },
        maxRetries: 0,
      });
      const result = await vie.analyze(f.path);
      expect(result.status.transcription).toBe("complete");
      expect(result.status.vision).toBe("failed");
      expect(result.transcript.segments[1]!.start).toBe(1);
      expect(JSON.stringify(result)).not.toContain(
        "private-key-must-not-appear",
      );
      expect(await readdir(temp)).toEqual([]);
      expect(vie.findMoments(result, "hello").status).toBe("matches");
      expect(vie.findMoments(result, "walking").status).toBe(
        "insufficient-evidence",
      );
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it("rejects empty, corrupt, over-limit, missing binaries and cancelled inputs", async () => {
    const f = await fixture();
    try {
      const vie = new VIE();
      await expect(vie.getMetadata(Buffer.alloc(0))).rejects.toMatchObject({
        code: "INPUT",
      });
      await expect(
        vie.getMetadata(Buffer.from("corrupt")),
      ).rejects.toMatchObject({ code: "MEDIA" });
      await expect(
        new VIE({ maxInputBytes: 1 }).getMetadata(f.path),
      ).rejects.toMatchObject({ code: "BUDGET" });
      await expect(
        new VIE({ ffprobe: "definitely-not-ffprobe" }).getMetadata(f.path),
      ).rejects.toMatchObject({ code: "FFMPEG_MISSING" });
      await expect(
        vie.analyze(f.path, { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      await writeFile(join(f.dir, "empty.mp4"), "");
      await expect(
        vie.getMetadata(join(f.dir, "empty.mp4")),
      ).rejects.toMatchObject({ code: "INPUT" });
      await expect(
        vie.getMetadata("https://example.com/video.mp4"),
      ).rejects.toMatchObject({ code: "INPUT" });
    } finally {
      await f.cleanup();
    }
  }, 30000);
});
