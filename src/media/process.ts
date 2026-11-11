import { spawn } from "node:child_process";
import { VIEError, checkAbort } from "../errors.js";
export async function run(
  binary: string,
  args: string[],
  signal?: AbortSignal,
  maxOutput = 8 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string }> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      killed = false;
    const abort = () => {
      killed = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (part: Buffer, output: "stdout" | "stderr") => {
      bytes += part.length;
      if (bytes > maxOutput) {
        killed = true;
        child.kill("SIGKILL");
        return;
      }
      if (output === "stdout") stdout += part.toString();
      else stderr += part.toString();
    };
    child.stdout.on("data", (p) => collect(p, "stdout"));
    child.stderr.on("data", (p) => collect(p, "stderr"));
    child.on("error", () => {
      signal?.removeEventListener("abort", abort);
      reject(
        new VIEError(
          "FFMPEG_MISSING",
          "Cannot start multimedia binary. Install FFmpeg 5+ and FFprobe or configure their paths.",
        ),
      );
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted)
        reject(new VIEError("CANCELLED", "Media processing cancelled"));
      else if (killed)
        reject(new VIEError("BUDGET", "Subprocess output limit exceeded"));
      else if (code !== 0)
        reject(
          new VIEError(
            "MEDIA",
            "Media processing failed; verify file integrity, codec support and binary configuration",
          ),
        );
      else resolve({ stdout, stderr });
    });
  });
}
export async function detectBinaries(
  ffmpeg = "ffmpeg",
  ffprobe = "ffprobe",
  signal?: AbortSignal,
) {
  const versions = await Promise.all(
    [ffmpeg, ffprobe].map(async (binary) => {
      const { stdout } = await run(binary, ["-version"], signal);
      const version = /version\s+(?:n)?(\d+)(?:\.(\d+))?/.exec(stdout);
      if (!version || Number(version[1]) < 5)
        throw new VIEError(
          "FFMPEG_MISSING",
          "FFmpeg and FFprobe version 5 or newer are required",
        );
      return version[0];
    }),
  );
  return { ffmpeg: versions[0], ffprobe: versions[1] };
}
