import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../tests/helpers.js";
import { VIE } from "../src/index.js";
import { loadConfig } from "../src/cli-config.js";
import { run } from "../src/media/process.js";
import { characterErrorRate, labeledTextPPM } from "./evaluation-metrics.js";
const out = "generated-artifacts";
await mkdir(out, { recursive: true });
const configIndex = process.argv.indexOf("--config");
const live = configIndex >= 0;
if (live && !process.argv.includes("--allow-provider-requests"))
  throw new Error(
    "Live evaluation requires --allow-provider-requests; requests may cost money and transmit synthetic media",
  );
const config = live ? await loadConfig(process.argv[configIndex + 1]) : {};
const results = [];
for (const ext of ["mp4", "mov", "mkv", "webm"]) {
  const f = await fixture(ext, false);
  try {
    const vie = new VIE({
      ...config,
      sampling: { mode: "custom", timestamps: [0, 0.5, 1, 1.5], maxFrames: 4 },
    });
    const analysis = await vie.analyze(f.path);
    const expectedCut = 1;
    const cuts = analysis.scenes.slice(1).map((s) => s.start);
    const matched = cuts.filter(
      (c) => Math.abs(c - expectedCut) <= 0.15,
    ).length;
    const error =
      analysis.frames.reduce(
        (sum, f, i) => sum + Math.abs(f.timestamp - [0, 0.5, 1, 1.5][i]!),
        0,
      ) / analysis.frames.length;
    // This controlled corpus has no moving entities; any activity claim is unsupported.
    const activities = analysis.observations.filter(
      (o) => o.kind === "activity",
    );
    results.push({
      container: ext,
      labels: {
        cuts: [1],
        sampleTimes: [0, 0.5, 1, 1.5],
        visibleText: [],
        activities: [],
      },
      scenePrecision: cuts.length ? Math.min(matched, 1) / cuts.length : 0,
      sceneRecall: matched ? 1 : 0,
      meanTimestampErrorSeconds: error,
      activityClaims: activities.length,
      unsupportedActivityClaims: activities.length,
      unsupportedClaimRate: analysis.observations.length
        ? activities.length / analysis.observations.length
        : null,
      ocr: live
        ? {
            falsePositiveTextCount: analysis.textOnScreen.length,
            note: "No positive OCR labels in color-only corpus",
          }
        : "not evaluated; no provider configured",
      providers: analysis.processing.providersUsed,
    });
  } finally {
    await f.cleanup();
  }
}
const report = {
  mode: live ? "optional-live-synthetic" : "native-only",
  runtime: process.version,
  results,
  limits:
    "Four synthetic hard-cut clips measure extraction, not general semantic accuracy. Unsupported-claim rate is null with no semantic observations. A real labeled corpus and provider-specific live review are required before stable accuracy claims.",
};
const textDir = await mkdtemp(join(tmpdir(), "vie-ocr-eval-"));
try {
  const image = join(textDir, "label.ppm");
  const video = join(textDir, "label.mp4");
  await writeFile(image, labeledTextPPM());
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-loop",
      "1",
      "-i",
      image,
      "-t",
      "1",
      "-r",
      "10",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y",
      video,
    ],
    AbortSignal.timeout(30000),
  );
  const analysis = await new VIE({
    ...config,
    sampling: { mode: "first", maxFrames: 1 },
  }).analyze(video);
  const available =
    live &&
    analysis.status.vision === "complete" &&
    analysis.processing.capabilities.some((p) => p.declared.ocr);
  const recognized = analysis.textOnScreen.map((o) => o.text).join(" ");
  Object.assign(report, {
    ocrEvaluation: {
      expected: "VIE 42",
      status: available ? "evaluated" : "not-evaluated",
      characterErrorRate: available
        ? characterErrorRate("VIE 42", recognized)
        : null,
      recognized: available ? recognized : undefined,
      note: "Positive OCR fixture uses a fixed synthetic font; not a substitute for real footage evaluation",
    },
  });
} finally {
  await rm(textDir, { recursive: true, force: true });
}
await writeFile(join(out, "evaluation.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
