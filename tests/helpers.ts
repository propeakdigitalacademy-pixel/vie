import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/media/process.js";
import type { Provider, Visual, Transcript } from "../src/types.js";
export const smallSignal = () => AbortSignal.timeout(30000);
export async function fixture(
  ext = "mp4",
  audio = true,
  options: {
    duration?: number;
    width?: number;
    height?: number;
    fps?: number;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "vie-test-"));
  const path = join(dir, `video.${ext}`);
  const duration = options.duration ?? 2;
  const w = options.width ?? 160;
  const h = options.height ?? 90;
  const codec = ext === "webm" ? "libvpx-vp9" : "libx264";
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=red:s=${w}x${h}:r=${options.fps ?? 10}:d=${duration / 2}`,
      "-f",
      "lavfi",
      "-i",
      `color=blue:s=${w}x${h}:r=${options.fps ?? 10}:d=${duration / 2}`,
      ...(audio
        ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`]
        : []),
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      ...(audio ? ["-map", "2:a"] : []),
      "-c:v",
      codec,
      ...(ext === "webm" ? ["-c:a", "libopus"] : ["-c:a", "aac"]),
      "-pix_fmt",
      "yuv420p",
      "-y",
      path,
    ],
    smallSignal(),
  );
  return {
    dir,
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
export function provider(
  id = "test",
  run?: Provider["run"],
  capability: Provider["capability"] = "vision",
): Provider {
  const visual: Visual = {
    description: "A colored surface",
    objects: [{ label: "surface" }],
    text: [],
  };
  const transcript: Transcript = {
    text: "hello",
    segments: [{ start: 0, end: 0.5, text: "hello" }],
    precision: "segment",
  };
  return {
    id,
    model: "test-model",
    location: "external",
    capability,
    capabilities: {
      images: capability === "vision",
      timestamps: capability === "transcription",
    },
    run: run ?? (async () => (capability === "vision" ? visual : transcript)),
  };
}
