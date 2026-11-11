import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configure, type Config } from "../config.js";
import type {
  AnalyzeOptions,
  Frame,
  MediaRequest,
  Observation,
  Provider,
  Provenance,
  Scene,
  Transcript,
  VIEConfig,
  VideoAnalysis,
  VideoInput,
  Visual,
} from "../types.js";
import { checkAbort, safeError, VIEError } from "../errors.js";
import { ingest } from "../media/ingest.js";
import * as native from "../media/native.js";
import { detectBinaries } from "../media/process.js";
import { DiskCache, digest } from "../cache.js";
import { Orchestrator, type RequestBudget } from "../fallback.js";
import { normalize } from "../providers/schema.js";

export class VIE {
  readonly config: Config;
  private orchestrator: Orchestrator;
  private cache: DiskCache;
  private binariesChecked = false;
  private pending = new WeakMap<
    AbortSignal,
    Map<string, Promise<{ value: Visual | Transcript; provenance: Provenance }>>
  >();
  constructor(config: VIEConfig = {}) {
    this.config = configure(config);
    this.orchestrator = new Orchestrator(this.config);
    this.cache = new DiskCache(this.config.cacheDir);
  }
  health() {
    return this.orchestrator.status();
  }
  clearCache() {
    return this.cache.clear();
  }
  status(signal?: AbortSignal) {
    return detectBinaries(
      this.config.ffmpeg,
      this.config.ffprobe,
      signal ?? AbortSignal.timeout(this.config.timeoutMs),
    );
  }
  private signal(signal?: AbortSignal) {
    return AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.config.maxRuntimeMs),
    ]);
  }
  private async ensureBinaries(signal: AbortSignal) {
    checkAbort(signal);
    if (!this.binariesChecked) {
      await this.status(signal);
      this.binariesChecked = true;
    }
  }
  private async scoped<T>(
    input: VideoInput,
    options: AnalyzeOptions,
    work: (
      media: Awaited<ReturnType<typeof ingest>>,
      signal: AbortSignal,
    ) => Promise<T>,
    retain = false,
  ): Promise<T> {
    const signal = this.signal(options.signal);
    await this.ensureBinaries(signal);
    const media = await ingest(input, this.config, signal);
    let success = false;
    try {
      const result = await work(media, signal);
      success = true;
      return result;
    } finally {
      if (!retain || !success) await media.cleanup();
    }
  }
  async getMetadata(input: VideoInput, options: AnalyzeOptions = {}) {
    return this.scoped(input, options, (m, s) =>
      native.metadata(m.path, this.config, s),
    );
  }
  async getScenes(
    input: VideoInput,
    options: AnalyzeOptions = {},
  ): Promise<Scene[]> {
    return this.scoped(input, options, async (m, s) => {
      const meta = await native.metadata(m.path, this.config, s);
      return meta.videoCodec
        ? native.scenes(
            m.path,
            Math.min(meta.duration, this.config.maxDuration),
            this.config,
            s,
          )
        : [];
    });
  }
  /** Extraction methods retain output files; caller owns the returned cleanup function. */
  async extractFrames(input: VideoInput, options: AnalyzeOptions = {}) {
    const signal = this.signal(options.signal);
    await this.ensureBinaries(signal);
    const media = await ingest(input, this.config, signal);
    try {
      const meta = await native.metadata(media.path, this.config, signal);
      const duration = Math.min(meta.duration, this.config.maxDuration);
      const sections = meta.videoCodec
        ? await native.scenes(media.path, duration, this.config, signal)
        : [];
      const frames = await native.frames(
        media.path,
        media.dir,
        duration,
        sections,
        meta,
        this.config,
        signal,
      );
      return { frames, cleanup: media.cleanup };
    } catch (error) {
      await media.cleanup();
      throw error;
    }
  }
  async getFrame(
    input: VideoInput,
    timestamp: number,
    options: AnalyzeOptions = {},
  ) {
    const vie = new VIE({
      ...this.config,
      sampling: {
        ...this.config.sampling,
        mode: "custom",
        timestamps: [timestamp],
        maxFrames: 1,
      },
    });
    const extracted = await vie.extractFrames(input, options);
    if (!extracted.frames.length) {
      await extracted.cleanup();
      throw new VIEError(
        "INPUT",
        "Timestamp is outside video or no video stream exists",
      );
    }
    return { frame: extracted.frames[0]!, cleanup: extracted.cleanup };
  }
  async extractAudio(input: VideoInput, options: AnalyzeOptions = {}) {
    const signal = this.signal(options.signal);
    await this.ensureBinaries(signal);
    const media = await ingest(input, this.config, signal);
    try {
      const meta = await native.metadata(media.path, this.config, signal);
      if (!meta.audioCodec)
        throw new VIEError("MEDIA", "No audio stream found");
      const path = await native.audio(
        media.path,
        join(media.dir, "audio.wav"),
        0,
        Math.min(meta.duration, this.config.maxDuration),
        this.config,
        signal,
      );
      return { path, cleanup: media.cleanup };
    } catch (error) {
      await media.cleanup();
      throw error;
    }
  }
  async getTranscript(input: VideoInput, options: AnalyzeOptions = {}) {
    const vie = new VIE({
      ...this.config,
      vision: { policy: "disabled" },
      sampling: { ...this.config.sampling, maxFrames: 1 },
    });
    const result = await vie.analyze(input, options);
    return {
      transcript: result.transcript,
      status: result.status.transcription,
      warnings: result.processing.warnings,
    };
  }
  private async request(request: MediaRequest, budget: RequestBudget) {
    const config = this.config[request.capability];
    const providers = config.providers as Provider[];
    // Persistent caching is explicit per adapter to account for endpoint/prompt/mapping revisions.
    const cacheable =
      providers.length > 0 && providers.every((p) => p.cacheIdentity);
    const hashes = await Promise.all(
      request.files.map(async (path) => digest(await readFile(path))),
    );
    const key = JSON.stringify({
      v: 1,
      namespace: this.config.cacheNamespace,
      cap: request.capability,
      policy: config.policy,
      shared: this.config.sharedFallbackEnabled,
      providers: providers.map((p) => [p.id, p.model, p.cacheIdentity]),
      hashes,
      prompt: request.prompt,
      language: request.language,
      timestamps: request.timestamps,
      duration: request.duration,
    });
    if (cacheable) {
      const found = await this.cache.get<{
        value: Visual | Transcript;
        provenance: Provenance;
      }>(key);
      if (found) {
        normalize(found.value, request);
        return {
          ...found,
          provenance: { ...found.provenance, cacheHit: true },
        };
      }
    }
    // Deduplication is analysis-scoped through the signal identity; never shares cancellation across analyses.
    let pending = this.pending.get(request.signal);
    if (!pending) {
      pending = new Map();
      this.pending.set(request.signal, pending);
    }
    const existing = pending.get(key);
    if (existing && cacheable) return existing;
    const operation = this.orchestrator.execute(config, request, budget);
    if (cacheable) pending.set(key, operation);
    try {
      const result = await operation;
      if (cacheable) {
        try {
          await this.cache.set(key, result);
        } catch {
          result.provenance.cacheWriteFailed = true;
        }
      }
      return result;
    } finally {
      pending.delete(key);
    }
  }
  async analyze(
    input: VideoInput,
    options: AnalyzeOptions = {},
  ): Promise<VideoAnalysis> {
    const started = Date.now();
    const c = this.config;
    const budget: RequestBudget = { requests: 0, retries: 0 };
    return this.scoped(
      input,
      options,
      async (media, signal) => {
        c.onProgress?.({ stage: "metadata" });
        const metadata = await native.metadata(media.path, c, signal);
        const duration = Math.min(metadata.duration, c.maxDuration);
        const result: VideoAnalysis = {
          schemaVersion: "1.0",
          sourceHash: media.hash,
          metadata,
          scenes: [],
          frames: [],
          evidence: [],
          transcript: {
            text: "",
            segments: [],
            precision: "unavailable",
            provenance: [],
          },
          observations: [],
          textOnScreen: [],
          events: [],
          timeline: [],
          coverage: {
            processedUntil: duration,
            sampledTimestamps: [],
            visualGaps: [],
            note: "Frame samples are point observations, not continuous video understanding. All intervals between samples are visually unexamined.",
            truncated: duration < metadata.duration,
          },
          status: {
            vision:
              c.vision.policy === "disabled"
                ? "disabled"
                : c.vision.providers.length
                  ? "complete"
                  : "unconfigured",
            transcription:
              c.transcription.policy === "disabled"
                ? "disabled"
                : c.transcription.providers.length
                  ? "complete"
                  : "unconfigured",
          },
          processing: {
            durationMs: 0,
            requests: 0,
            warnings: [],
            providersUsed: [],
            fallbacksUsed: false,
            failures: [],
            capabilities: [
              ...c.vision.providers,
              ...c.transcription.providers,
            ].map((p: Provider) => ({
              id: p.id,
              model: p.model,
              capability: p.capability,
              location: p.location,
              declared: p.capabilities,
            })),
          },
        };
        const warn = (message: string) => {
          if (!result.processing.warnings.includes(message))
            result.processing.warnings.push(message);
        };
        if (duration < metadata.duration)
          warn("Duration budget truncated native and AI processing");
        if (metadata.videoCodec) {
          c.onProgress?.({ stage: "scenes" });
          result.scenes = await native.scenes(media.path, duration, c, signal);
          result.frames = await native.frames(
            media.path,
            media.dir,
            duration,
            result.scenes,
            metadata,
            c,
            signal,
          );
          for (const scene of result.scenes)
            result.evidence.push({
              id: scene.id,
              kind: "scene",
              start: scene.start,
              end: scene.end,
              sourceTimestamp: scene.start + (metadata.startTime ?? 0),
            });
          for (const frame of result.frames)
            result.evidence.push({
              id: frame.id,
              kind: "frame",
              start: frame.timestamp,
              sourceTimestamp: frame.sourceTimestamp,
            });
        } else result.status.vision = "unavailable";
        const addProvenance = (p: Provenance) => {
          if (p.cacheWriteFailed)
            warn(
              "Provider succeeded but persistent cache write failed; result was preserved",
            );
          if (
            p.successful &&
            !result.processing.providersUsed.includes(p.successful)
          )
            result.processing.providersUsed.push(p.successful);
          result.processing.fallbacksUsed ||= p.fallbackUsed;
        };
        const fail = (
          cap: "vision" | "transcription",
          error: unknown,
          successes: number,
        ) => {
          checkAbort(options.signal);
          result.status[cap] = successes ? "partial" : "failed";
          const e = safeError(error);
          warn(`${cap}: ${e.code}; no unsupported claims were substituted`);
          result.processing.failures.push({
            capability: cap,
            code: e.code,
            provenance: (error as { provenance?: Provenance })?.provenance,
          });
          result.processing.fallbacksUsed ||= !!(
            error as { provenance?: Provenance }
          )?.provenance?.fallbackUsed;
          if (e.code === "BUDGET" || signal.aborted)
            result.coverage.truncated = true;
        };
        if (metadata.audioCodec && result.status.transcription === "complete") {
          let successes = 0;
          const total = Math.ceil(duration / c.audioChunkSeconds);
          for (let i = 0; i < total; i++) {
            const start = i * c.audioChunkSeconds;
            const length = Math.min(c.audioChunkSeconds, duration - start);
            try {
              checkAbort(signal);
              const path = await native.audio(
                media.path,
                join(media.dir, `audio-${i}.wav`),
                start,
                length,
                c,
                signal,
              );
              const processed = await this.request(
                {
                  capability: "transcription",
                  files: [path],
                  timestamps: [start],
                  duration: length,
                  language: c.language,
                  prompt: "Transcribe the audio",
                  signal,
                },
                budget,
              );
              const transcript = processed.value as Transcript;
              const evidenceId = `audio-${i}`;
              result.evidence.push({
                id: evidenceId,
                kind: "audio",
                start,
                end: start + length,
                sourceTimestamp: start + (metadata.startTime ?? 0),
              });
              result.transcript.text += [
                result.transcript.text ? " " : "",
                transcript.text,
              ].join("");
              result.transcript.language ??= transcript.language;
              // Plain text has only chunk precision. Never label synthesized ranges as word/segment timestamps.
              const segments = transcript.segments.length
                ? transcript.segments
                : [{ text: transcript.text, start: 0, end: length }];
              const precision = transcript.segments.length
                ? transcript.precision
                : "chunk";
              result.transcript.precision =
                result.transcript.precision === "unavailable"
                  ? precision
                  : result.transcript.precision === precision
                    ? precision
                    : "chunk";
              for (const segment of segments) {
                const shifted = {
                  ...segment,
                  start:
                    segment.start === undefined
                      ? undefined
                      : start + segment.start,
                  end:
                    segment.end === undefined ? undefined : start + segment.end,
                  words: segment.words?.map((w) => ({
                    ...w,
                    start: start + w.start,
                    end: start + w.end,
                  })),
                };
                result.transcript.segments.push(shifted);
                result.timeline.push({
                  timestamp: shifted.start ?? start,
                  end: shifted.end ?? start + length,
                  type: "speech",
                  description: shifted.text,
                  evidence: [evidenceId],
                });
              }
              result.transcript.provenance.push(processed.provenance);
              addProvenance(processed.provenance);
              successes++;
              c.onProgress?.({
                stage: "transcription",
                completed: i + 1,
                total,
              });
            } catch (error) {
              fail("transcription", error, successes);
              if (signal.aborted || safeError(error).code === "BUDGET") break;
            }
          }
        } else if (
          !metadata.audioCodec &&
          c.transcription.policy !== "disabled"
        )
          result.status.transcription = "unavailable";
        if (result.status.vision === "complete") {
          let successes = 0;
          // Sequence input is supplied only when *all* possible providers declare temporal support.
          const sequences =
            c.actions &&
            (c.vision.providers as Provider[]).every(
              (p) => p.capabilities.activities && p.capabilities.multipleImages,
            );
          const batches: Frame[][] = [];
          if (sequences)
            for (const scene of result.scenes) {
              const fs = result.frames.filter((f) => f.sceneId === scene.id);
              for (let i = 0; i < fs.length; i += 4)
                batches.push(fs.slice(i, i + 4));
            }
          else for (const frame of result.frames) batches.push([frame]);
          for (let i = 0; i < batches.length; i++) {
            const batch = batches[i]!;
            try {
              checkAbort(signal);
              const processed = await this.request(
                {
                  capability: "vision",
                  files: batch.map((f) => f.path!),
                  timestamps: batch.map((f) => f.timestamp),
                  prompt: `Describe only visible evidence. Do not infer movement from a still image. ${c.ocr ? "Read visible text." : ""} ${c.objects ? "Identify visible objects." : ""} ${sequences ? "Report activities only with indices of at least two supporting frames." : ""}`,
                  signal,
                },
                budget,
              );
              const visual = processed.value as Visual;
              const first = batch[0]!;
              const add = (
                kind: Observation["kind"],
                text: string,
                evidence: Frame[] = batch,
                confidence?: number,
              ) => {
                const o: Observation = {
                  id: `observation-${result.observations.length}`,
                  kind,
                  text,
                  start: evidence[0]!.timestamp,
                  end:
                    evidence.length > 1
                      ? evidence.at(-1)!.timestamp
                      : undefined,
                  evidence: evidence.map((f) => f.id),
                  basis:
                    kind === "classification" || kind === "activity"
                      ? "inference"
                      : "provider-observation",
                  confidence,
                  provenance: processed.provenance,
                };
                result.observations.push(o);
                result.scenes
                  .find((s) => s.id === first.sceneId)
                  ?.observations.push(o.id);
                result.timeline.push({
                  timestamp: o.start,
                  end: o.end,
                  type: kind,
                  description: text,
                  evidence: o.evidence,
                });
                if (kind === "ocr") result.textOnScreen.push(o);
                if (kind === "activity")
                  result.events.push({
                    timestamp: o.start,
                    end: o.end,
                    type: kind,
                    description: text,
                    evidence: o.evidence,
                  });
              };
              add("description", visual.description);
              if (c.objects)
                for (const object of visual.objects ?? [])
                  add("object", object.label, batch, object.confidence);
              if (c.ocr)
                for (const text of visual.text ?? [])
                  add("ocr", text.text, batch, text.confidence);
              if (visual.environment) add("environment", visual.environment);
              if (visual.composition) add("composition", visual.composition);
              for (const category of visual.categories ?? [])
                add("classification", category);
              if (sequences && batch.length > 1)
                for (const activity of visual.activities ?? []) {
                  const indices = [...new Set(activity.frameIndices)];
                  const evidence = indices
                    .map((index) => batch[index])
                    .filter((f): f is Frame => !!f)
                    .sort((a, b) => a.timestamp - b.timestamp);
                  if (
                    evidence.length >= 2 &&
                    evidence[0]!.timestamp !== evidence.at(-1)!.timestamp
                  )
                    add(
                      "activity",
                      activity.description,
                      evidence,
                      activity.confidence,
                    );
                  else
                    warn(
                      "Rejected activity with insufficient temporal evidence",
                    );
                }
              else if (visual.activities?.length)
                warn("Rejected activity from still-image evidence");
              successes++;
              addProvenance(processed.provenance);
              c.onProgress?.({
                stage: "vision",
                completed: i + 1,
                total: batches.length,
              });
            } catch (error) {
              fail("vision", error, successes);
              if (signal.aborted || safeError(error).code === "BUDGET") break;
            }
          }
        }
        const times = result.frames
          .map((f) => f.timestamp)
          .sort((a, b) => a - b);
        result.coverage.sampledTimestamps = times;
        const boundaries = [0, ...times, metadata.duration];
        result.coverage.visualGaps = boundaries
          .slice(0, -1)
          .flatMap((t, i) =>
            boundaries[i + 1]! > t
              ? [{ start: t, end: boundaries[i + 1]! }]
              : [],
          );
        if (result.frames.length === c.sampling.maxFrames) {
          result.coverage.truncated = true;
          warn("Maximum frame budget reached");
        }
        for (const scene of result.scenes) {
          const event = {
            timestamp: scene.start,
            end: scene.end,
            type: "scene",
            description: "Native scene interval",
            evidence: [scene.id],
          };
          result.events.push(event);
          result.timeline.push(event);
        }
        result.timeline.sort((a, b) => a.timestamp - b.timestamp);
        result.events.sort((a, b) => a.timestamp - b.timestamp);
        if (!result.observations.length)
          warn("Insufficient visual evidence for semantic claims");
        if (!c.retain) for (const f of result.frames) delete f.path;
        result.processing.durationMs = Date.now() - started;
        result.processing.requests = budget.requests;
        const successes = [
          ...result.transcript.provenance,
          ...result.observations.map((o) => o.provenance),
        ];
        const distinct = [...new Set(successes)].filter((p) => !p.cacheHit);
        const currencies = new Set(
          distinct.map((p) => c.pricing?.[p.successful ?? ""]?.currency),
        );
        // Request-based pricing excludes unknown failed-attempt billing, so is explicitly a lower-bound estimate.
        if (
          distinct.length &&
          c.pricing &&
          currencies.size === 1 &&
          !currencies.has(undefined)
        )
          result.processing.costEstimate = {
            amount: distinct.reduce(
              (sum, p) => sum + c.pricing![p.successful!]!.perRequest,
              0,
            ),
            currency: [...currencies][0]!,
            basis:
              "Configured successful-request prices only; excludes retries, tokens and provider-side billing",
          };
        if (options.checkpointPath)
          await writeFile(
            options.checkpointPath,
            JSON.stringify(result, null, 2),
            { mode: 0o600, flag: "wx" },
          ).catch(() => {
            throw new VIEError(
              "INPUT",
              "Cannot write snapshot; choose a new writable path. Existing files are never overwritten",
            );
          });
        c.onProgress?.({ stage: "complete" });
        return result;
      },
      c.retain,
    );
  }
  search(
    result: VideoAnalysis,
    query: string,
    filter: { type?: string; start?: number; end?: number } = {},
  ) {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return result.timeline.filter(
      (e) =>
        terms.every((term) =>
          e.description.toLocaleLowerCase().includes(term),
        ) &&
        (!filter.type || e.type === filter.type) &&
        e.timestamp >= (filter.start ?? 0) &&
        e.timestamp <= (filter.end ?? Infinity),
    );
  }
  findMoments(result: VideoAnalysis, query: string) {
    const matches = this.search(result, query);
    return {
      status: matches.length
        ? ("matches" as const)
        : ("insufficient-evidence" as const),
      matches,
      note: "Lexical search of available evidence, not semantic proof of absence",
    };
  }
}
