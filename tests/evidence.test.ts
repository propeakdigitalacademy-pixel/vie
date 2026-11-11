import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { VIE } from "../src/index.js";
import { fixture, provider } from "./helpers.js";
import { configure } from "../src/config.js";
import { sampleTimes } from "../src/media/native.js";
describe("sampling configuration and bounds", () => {
  const sections = [
    { id: "a", start: 0, end: 2, duration: 2, frames: [], observations: [] },
    { id: "b", start: 2, end: 4, duration: 2, frames: [], observations: [] },
  ];
  it.each([
    ["first", [0]],
    ["last", [3.95]],
    ["middle", [2]],
    ["scene", [1, 3]],
    ["custom", [0.5, 2]],
  ] as const)("implements %s sampling", (mode, expected) => {
    expect(
      sampleTimes(
        4,
        sections,
        configure({ sampling: { mode, timestamps: [0.5, 2, 100] } }),
      ),
    ).toEqual([...expected]);
  });
  it("bounds fixed, fps and adaptive candidates and validates unsafe configuration", () => {
    expect(
      sampleTimes(
        1e12,
        sections,
        configure({ sampling: { mode: "fps", fps: 60, maxFrames: 3 } }),
      ),
    ).toHaveLength(3);
    expect(
      sampleTimes(
        4,
        sections,
        configure({ sampling: { mode: "adaptive", maxFrames: 3 } }),
      ),
    ).toHaveLength(3);
    for (const c of [
      { maxRuntimeMs: 0 },
      { sampling: { interval: 0 } },
      { sampling: { maxFrames: Infinity } },
      { unknown: true },
    ])
      expect(() => configure(c)).toThrow();
  });
});
describe("evidence-backed outputs and cache invalidation", () => {
  it("suppresses movement claims based on a single still and labels classification as inference", async () => {
    const f = await fixture("mp4", false);
    try {
      const p = provider("mock", async () => ({
        description: "red surface",
        categories: ["abstract"],
        activities: [{ description: "walking", frameIndices: [0, 1] }],
      }));
      const result = await new VIE({
        vision: { providers: [p] },
        actions: true,
        sampling: { maxFrames: 1 },
      }).analyze(f.path);
      expect(result.observations.some((o) => o.kind === "activity")).toBe(
        false,
      );
      expect(
        result.observations.find((o) => o.kind === "classification")!.basis,
      ).toBe("inference");
      expect(
        result.observations.every((o) =>
          o.evidence.every((ref) => result.evidence.some((e) => e.id === ref)),
        ),
      ).toBe(true);
      expect(result.observations.every((o) => o.confidence === undefined)).toBe(
        true,
      );
      expect(result.processing.warnings).toContain(
        "Rejected activity from still-image evidence",
      );
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it("only accepts sequence activity references with two distinct source frames", async () => {
    const f = await fixture("mp4", false);
    try {
      const p = {
        ...provider("temporal", async () => ({
          description: "changing color",
          activities: [
            { description: "visual change", frameIndices: [0, 1] },
            { description: "unsupported", frameIndices: [0, 0] },
          ],
        })),
        capabilities: { images: true, multipleImages: true, activities: true },
      };
      const r = await new VIE({
        vision: { providers: [p] },
        actions: true,
        sampling: {
          mode: "custom",
          timestamps: [0, 0.2, 1, 1.2],
          maxFrames: 4,
        },
      }).analyze(f.path);
      expect(r.observations.filter((o) => o.kind === "activity")).toHaveLength(
        2,
      );
      expect(
        r.observations
          .filter((o) => o.kind === "activity")
          .every(
            (o) =>
              o.basis === "inference" &&
              o.evidence.length === 2 &&
              o.end! > o.start,
          ),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it("never calls providers in disabled/local-only or unconfigured states", async () => {
    const f = await fixture();
    try {
      const run = vi.fn(async () => ({ description: "external" }));
      const p = provider("external", run);
      for (const policy of ["disabled", "local-only"] as const) {
        const r = await new VIE({
          vision: { policy, providers: [p] },
          sampling: { maxFrames: 1 },
        }).analyze(f.path);
        expect(r.frames).toHaveLength(1);
        expect(run).not.toHaveBeenCalled();
      }
      const r = await new VIE({
        vision: { providers: [] },
        transcription: { providers: [] },
      }).analyze(f.path);
      expect(r.status).toEqual({
        vision: "unconfigured",
        transcription: "unconfigured",
      });
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it("bounds request counts, records failed provenance and keeps successful native results", async () => {
    const f = await fixture("mp4", false);
    try {
      const r = await new VIE({
        vision: { providers: [provider()] },
        maxRequests: 1,
        sampling: { interval: 0.2, maxFrames: 8 },
      }).analyze(f.path);
      expect(r.processing.requests).toBe(1);
      expect(r.status.vision).toBe("partial");
      expect(r.coverage.truncated).toBe(true);
      expect(r.frames).toHaveLength(8);
      const fail = await new VIE({
        vision: {
          providers: [
            provider("broken", async () => {
              throw new Error("network");
            }),
          ],
        },
        maxRetries: 0,
        sampling: { maxFrames: 1 },
      }).analyze(f.path);
      expect(
        fail.processing.failures[0]!.provenance!.attempts[0]!.provider,
      ).toBe("broken");
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it("caches only explicitly versioned providers and invalidates by namespace, model and configuration", async () => {
    const f = await fixture("mp4", false);
    try {
      const run = vi.fn(async () => ({ description: "red" }));
      const p = { ...provider("cached", run), cacheIdentity: "adapter-v1" };
      const c = {
        cacheDir: join(f.dir, "cache"),
        vision: { providers: [p] },
        sampling: { maxFrames: 1 },
      };
      const vie = new VIE(c);
      await vie.analyze(f.path);
      const cached = await vie.analyze(f.path);
      expect(run).toHaveBeenCalledTimes(1);
      expect(cached.observations[0]!.provenance.cacheHit).toBe(true);
      expect(cached.processing.requests).toBe(0);
      await new VIE({ ...c, cacheNamespace: "other-tenant" }).analyze(f.path);
      expect(run).toHaveBeenCalledTimes(2);
      await new VIE({
        ...c,
        vision: { providers: [{ ...p, model: "other-model" }] },
      }).analyze(f.path);
      expect(run).toHaveBeenCalledTimes(3);
      await vie.clearCache();
      await vie.analyze(f.path);
      expect(run).toHaveBeenCalledTimes(4);
    } finally {
      await f.cleanup();
    }
  }, 30000);
});
