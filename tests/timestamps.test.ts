import { describe, it, expect } from "vitest";
import { fixture } from "./helpers.js";
import { VIE } from "../src/index.js";
describe("actual decoded timestamps rather than requested precision", () => {
  it("extracts the last real low-rate frame and deduplicates oversampling", async () => {
    const f = await fixture("mp4", false, { duration: 2, fps: 1 });
    try {
      const last = await new VIE({ sampling: { mode: "last" } }).extractFrames(
        f.path,
      );
      try {
        expect(last.frames[0]!.timestamp).toBe(1);
      } finally {
        await last.cleanup();
      }
      const oversampled = await new VIE({
        sampling: { mode: "fps", fps: 30, maxFrames: 8 },
        maxDuration: 0.5,
      }).analyze(f.path);
      expect(oversampled.frames).toHaveLength(1);
      expect(oversampled.frames[0]!.timestamp).toBe(0);
    } finally {
      await f.cleanup();
    }
  }, 30000);
  it("reports actual frame PTS for a request between decoded frames", async () => {
    const f = await fixture("mp4", false, { duration: 2, fps: 10 });
    try {
      const extracted = await new VIE().getFrame(f.path, 0.05);
      try {
        expect(extracted.frame.timestamp).toBeCloseTo(0.1, 5);
        expect(extracted.frame.timestamp).not.toBe(0.05);
      } finally {
        await extracted.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  }, 30000);
});
