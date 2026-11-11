import { z } from "zod";
import type { VIEConfig } from "./types.js";
import { VIEError } from "./errors.js";
const positive = z.number().finite().positive();
const capability = z
  .object({
    policy: z
      .enum(["strict", "user-only", "automatic", "local-only", "disabled"])
      .default("user-only"),
    providers: z
      .array(z.custom<any>((v) => !!v && typeof (v as any).run === "function"))
      .default([]),
  })
  .strict();
const schema = z
  .object({
    ffmpeg: z.string().default(process.env.VIE_FFMPEG || "ffmpeg"),
    ffprobe: z.string().default(process.env.VIE_FFPROBE || "ffprobe"),
    tempDir: z.string().optional(),
    retain: z.boolean().default(false),
    maxInputBytes: positive.int().default(512 * 1024 * 1024),
    allowRemote: z.boolean().default(false),
    maxDuration: positive.default(3600),
    maxRuntimeMs: positive.int().default(300000),
    maxRequests: positive.int().default(100),
    maxRetries: z.number().int().min(0).max(10).default(2),
    retryBudget: z.number().int().min(0).default(20),
    concurrency: positive.int().max(32).default(2),
    timeoutMs: positive.int().default(30000),
    backoffMs: positive.default(500),
    circuitThreshold: positive.int().default(3),
    circuitRecoveryMs: positive.default(30000),
    sampling: z
      .object({
        mode: z
          .enum([
            "fixed",
            "fps",
            "scene",
            "adaptive",
            "custom",
            "first",
            "last",
            "middle",
          ])
          .default("fixed"),
        interval: positive.default(10),
        fps: positive.max(60).default(1),
        timestamps: z
          .array(z.number().finite().nonnegative())
          .max(100000)
          .default([]),
        maxFrames: positive.int().max(10000).default(30),
        maxDimension: positive.int().max(4096).default(1024),
        quality: z.number().int().min(2).max(31).default(3),
      })
      .strict()
      .default({
        mode: "fixed",
        interval: 10,
        fps: 1,
        timestamps: [],
        maxFrames: 30,
        maxDimension: 1024,
        quality: 3,
      }),
    sceneThreshold: z.number().min(0).max(1).default(0.3),
    audioChunkSeconds: positive.min(1).max(600).default(120),
    language: z.string().optional(),
    vision: capability.default({ policy: "disabled", providers: [] }),
    transcription: capability.default({ policy: "disabled", providers: [] }),
    sharedFallbackEnabled: z.boolean().default(false),
    ocr: z.boolean().default(true),
    objects: z.boolean().default(true),
    actions: z.boolean().default(false),
    cacheDir: z.string().optional(),
    cacheNamespace: z.string().default("default"),
    pricing: z
      .record(
        z.string(),
        z.object({
          perRequest: z.number().nonnegative(),
          currency: z.string().length(3),
        }),
      )
      .optional(),
    onProgress: z
      .custom<VIEConfig["onProgress"]>((v) => typeof v === "function")
      .optional(),
  })
  .strict();
export type Config = z.infer<typeof schema>;
export function configure(config: VIEConfig = {}): Config {
  const parsed = schema.safeParse(config);
  if (!parsed.success)
    throw new VIEError(
      "CONFIG",
      `Invalid configuration fields: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  for (const cap of ["vision", "transcription"] as const) {
    const ids = new Set<string>();
    for (const p of parsed.data[cap].providers) {
      if (
        p.capability !== cap ||
        !p.id ||
        !p.model ||
        !["local", "external"].includes(p.location)
      )
        throw new VIEError(
          "CONFIG",
          "Provider capability or identity is invalid",
        );
      if (ids.has(p.id))
        throw new VIEError(
          "CONFIG",
          "Provider IDs must be unique within a capability",
        );
      ids.add(p.id);
    }
  }
  return parsed.data;
}
