import type { MediaRequest } from "../types.js";
import { VIEError } from "../errors.js";

export interface VisualOptions {
  structured?: boolean;
  /** Opt in only when the selected model can compare ordered image sequences. */
  temporal?: boolean;
}

export function visualPrompt(options: VisualOptions, request: MediaRequest) {
  if (!options.structured && !options.temporal) return request.prompt;
  const fields =
    "Return only JSON with a description string, optional objects array of {label}, optional text array of {text}, optional environment and composition strings. Do not invent confidence values.";
  if (!options.temporal || request.files.length < 2)
    return `${request.prompt}\n${fields} Describe only visible evidence. Do not report actions or movement from a still image.`;
  return `${request.prompt}\n${fields} Images are in the supplied chronological order. Frame indices are zero-based; timestamps in seconds are ${JSON.stringify(request.timestamps)}. You may include an activities array of {description, frameIndices}, but only for visible changes supported by at least two distinct frames. Do not infer what happened in unsampled intervals, invent identities, or turn poses into movement. Omit unsupported activities. Categories, if included as a string array, are inferences, not directly observed facts.`;
}

export function visualContent(value: unknown, structured = false) {
  if (typeof value !== "string")
    throw new VIEError("MALFORMED", "Missing vision description");
  if (!structured) return { description: value };
  try {
    return JSON.parse(value);
  } catch {
    throw new VIEError(
      "MALFORMED",
      "Vision provider did not return structured JSON",
    );
  }
}
