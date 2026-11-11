import { describe, it, expect } from "vitest";
import {
  characterErrorRate,
  labeledTextPPM,
} from "../scripts/evaluation-metrics.js";
describe("labeled evaluation metrics", () => {
  it("measures OCR edit errors without inventing unavailable accuracy", () => {
    expect(characterErrorRate("VIE 42", "VIE 42")).toBe(0);
    expect(characterErrorRate("VIE 42", "")).toBe(1);
    expect(characterErrorRate("VIE 42", "VIE 43")).toBeCloseTo(1 / 6);
    expect(labeledTextPPM().subarray(0, 2).toString()).toBe("P6");
  });
});
