import { z } from "zod";
import type { MediaRequest, Transcript, Visual } from "../types.js";
import { VIEError } from "../errors.js";
const confidence = z.number().min(0).max(1).optional();
const time = z.number().finite().nonnegative();
const segment = z.object({
  start: time.optional(),
  end: time.optional(),
  text: z.string(),
  speaker: z.string().optional(),
  confidence,
  words: z
    .array(z.object({ start: time, end: time, text: z.string() }))
    .optional(),
});
export const transcriptSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  segments: z.array(segment),
  precision: z.enum(["word", "segment", "chunk", "unavailable"]),
});
export const visualSchema = z.object({
  description: z.string(),
  objects: z.array(z.object({ label: z.string(), confidence })).optional(),
  text: z.array(z.object({ text: z.string(), confidence })).optional(),
  environment: z.string().optional(),
  composition: z.string().optional(),
  categories: z.array(z.string()).optional(),
  activities: z
    .array(
      z.object({
        description: z.string(),
        frameIndices: z.array(z.number().int().nonnegative()).min(2),
        confidence,
      }),
    )
    .optional(),
});
export function normalize(
  value: unknown,
  request: MediaRequest,
): Visual | Transcript {
  const parsed = (
    request.capability === "vision" ? visualSchema : transcriptSchema
  ).safeParse(value);
  if (!parsed.success)
    throw new VIEError(
      "MALFORMED",
      "Provider returned an invalid normalized response",
    );
  if (request.capability === "transcription") {
    const t = parsed.data as Transcript;
    for (const s of t.segments) {
      if (
        (s.start === undefined) !== (s.end === undefined) ||
        (s.start !== undefined &&
          (s.end! < s.start || s.end! > (request.duration ?? Infinity) + 0.1))
      )
        throw new VIEError(
          "MALFORMED",
          "Transcript timestamp outside audio chunk",
        );
      for (const w of s.words ?? [])
        if (w.end < w.start || w.end > (request.duration ?? Infinity) + 0.1)
          throw new VIEError("MALFORMED", "Word timestamp outside audio chunk");
    }
    return t;
  }
  return parsed.data as Visual;
}
