import { stat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Metadata, Scene, Frame } from "../types.js";
import { VIEError, checkAbort } from "../errors.js";
import { run } from "./process.js";
// Playlist/manifest demuxers can reference unrelated local files. Only self-contained
// media containers are accepted even when FFmpeg was compiled with network protocols.
const inputArgs = (path: string) => [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,avi,flv,mpeg,mpegts,m4v,mp3,wav,aac,ogg,flac,asf,mjpeg",
  "-i",
  path,
];
const number = (value: unknown): number | undefined =>
  value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : undefined;
const rational = (value?: string): number | undefined => {
  const [a, b] = value?.split("/").map(Number) ?? [];
  return a !== undefined && b ? a / b : undefined;
};
export async function metadata(
  path: string,
  c: Config,
  signal: AbortSignal,
): Promise<Metadata> {
  const { stdout } = await run(
    c.ffprobe,
    [
      "-v",
      "error",
      ...inputArgs(path),
      "-show_format",
      "-show_streams",
      "-of",
      "json",
    ],
    signal,
  );
  const raw = JSON.parse(stdout);
  const streams: any[] = raw.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const duration =
    number(raw.format?.duration) ?? number(v?.duration) ?? number(a?.duration);
  if (duration === undefined || duration <= 0)
    throw new VIEError("FORMAT", "No finite media duration found");
  return {
    duration,
    fileSize: (await stat(path)).size,
    format: raw.format?.format_name,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    width: number(v?.width),
    height: number(v?.height),
    aspectRatio: v?.display_aspect_ratio,
    fps: rational(v?.r_frame_rate),
    averageFps: rational(v?.avg_frame_rate),
    pixelFormat: v?.pix_fmt,
    bitrate: number(raw.format?.bit_rate),
    sampleRate: number(a?.sample_rate),
    channels: number(a?.channels),
    rotation: number(
      v?.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ??
        v?.tags?.rotate,
    ),
    startTime: number(raw.format?.start_time),
    streamCount: streams.length,
    raw,
  };
}
export async function scenes(
  path: string,
  duration: number,
  c: Config,
  signal: AbortSignal,
): Promise<Scene[]> {
  const { stderr } = await run(
    c.ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      ...inputArgs(path),
      "-map",
      "0:v:0",
      "-t",
      String(duration),
      "-an",
      "-vf",
      `select='gt(scene,${c.sceneThreshold})',showinfo`,
      "-fps_mode",
      "vfr",
      "-f",
      "null",
      "-",
    ],
    signal,
  );
  const cuts = [...stderr.matchAll(/pts_time:([\d.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((t) => t > 0 && t < duration);
  const boundaries = [0, ...new Set(cuts), duration].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, i) => ({
    id: `scene-${i}`,
    start,
    end: boundaries[i + 1]!,
    duration: boundaries[i + 1]! - start,
    frames: [],
    observations: [],
  }));
}
export function sampleTimes(
  duration: number,
  sections: Scene[],
  c: Config,
): number[] {
  const s = c.sampling;
  let times: number[] = [];
  const last = Math.max(0, duration - 0.05);
  if (s.mode === "custom") times = s.timestamps;
  else if (s.mode === "first") times = [0];
  else if (s.mode === "last") times = [last];
  else if (s.mode === "middle") times = [duration / 2];
  else if (s.mode === "scene")
    times = sections.map((v) => (v.start + v.end) / 2);
  else {
    const interval = s.mode === "fps" ? 1 / s.fps : s.interval;
    // Candidate generation itself is bounded, even for multi-day media.
    const count = Math.min(s.maxFrames, Math.ceil(duration / interval));
    times = Array.from({ length: count }, (_, i) => i * interval);
    if (s.mode === "adaptive")
      times = [
        ...sections.flatMap((v) => [
          Math.max(0, v.start - 0.1),
          v.start,
          Math.min(last, v.start + 0.1),
          (v.start + v.end) / 2,
        ]),
        ...times,
      ];
  }
  return [...new Set(times.filter((t) => t >= 0 && t < duration))]
    .sort((a, b) => a - b)
    .slice(0, s.maxFrames);
}
export async function frames(
  path: string,
  dir: string,
  duration: number,
  sections: Scene[],
  meta: Metadata,
  c: Config,
  signal: AbortSignal,
): Promise<Frame[]> {
  if (!meta.videoCodec) return [];
  const times = sampleTimes(duration, sections, c);
  const result: Frame[] = [];
  if (!times.length) return result;
  // Query actual final decoded PTS, rather than estimating the final frame from FPS.
  // read_intervals seeks to a nearby keyframe; subprocess output/runtime caps still apply.
  const offset = meta.startTime ?? 0;
  const tail = await run(
    c.ffprobe,
    [
      "-v",
      "error",
      ...inputArgs(path),
      "-select_streams",
      "v:0",
      "-read_intervals",
      `${(Math.max(0, duration - 2) + offset).toFixed(9)}%${(duration + offset).toFixed(9)}`,
      "-show_entries",
      "frame=best_effort_timestamp_time",
      "-of",
      "json",
    ],
    signal,
  );
  const tailTimes = (JSON.parse(tail.stdout).frames ?? [])
    .map((f: any) => number(f.best_effort_timestamp_time))
    .filter((t: unknown): t is number => typeof t === "number")
    .map((t: number) => t - offset)
    .filter((t: number) => t >= 0 && t < duration);
  if (!tailTimes.length)
    throw new VIEError(
      "MEDIA",
      "Cannot establish the final decoded frame timestamp",
    );
  const lastTimestamp = tailTimes.reduce(
    (max: number, t: number) => Math.max(max, t),
    0,
  );
  for (const requested of times) {
    const timestamp = Math.min(requested, lastTimestamp);
    checkAbort(signal);
    const output = join(dir, `frame-${result.length}.jpg`);
    const { stderr } = await run(
      c.ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        ...inputArgs(path),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        `select='gte(t,${Math.max(0, timestamp - 0.000001)})',scale=w='min(${c.sampling.maxDimension},iw)':h='min(${c.sampling.maxDimension},ih)':force_original_aspect_ratio=decrease,showinfo`,
        "-fps_mode",
        "vfr",
        "-q:v",
        String(c.sampling.quality),
        "-y",
        output,
      ],
      signal,
    );
    // Dimensions come from the generated JPEG, timing from the emitted source frame.
    const probe = await run(
      c.ffprobe,
      ["-v", "error", "-show_streams", "-of", "json", output],
      signal,
    );
    const stream = JSON.parse(probe.stdout).streams[0];
    const pts = [...stderr.matchAll(/pts_time:([-\d.]+)/g)]
      .map((m) => Number(m[1]))
      .filter((t) => t >= timestamp - 0.00001);
    const actual = pts[0];
    if (actual === undefined)
      throw new VIEError(
        "MEDIA",
        "Decoded frame timestamp is unavailable; refusing to guess",
      );
    if (result.some((f) => Math.abs(f.timestamp - actual) < 0.000001)) {
      await rm(output, { force: true });
      continue;
    }
    const section = sections.find((s) => actual >= s.start && actual < s.end);
    const frame: Frame = {
      id: `frame-${result.length}`,
      timestamp: actual,
      sourceTimestamp: actual + (meta.startTime ?? 0),
      width: stream.width,
      height: stream.height,
      format: "jpeg",
      path: output,
      sceneId: section?.id,
    };
    result.push(frame);
    section?.frames.push(frame.id);
    c.onProgress?.({
      stage: "frames",
      completed: result.length,
      total: times.length,
    });
  }
  return result;
}
export async function audio(
  path: string,
  output: string,
  start: number,
  duration: number,
  c: Config,
  signal: AbortSignal,
): Promise<string> {
  await run(
    c.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...inputArgs(path),
      "-map",
      "0:a:0",
      "-ss",
      String(start),
      "-t",
      String(duration),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-y",
      output,
    ],
    signal,
  );
  return output;
}
