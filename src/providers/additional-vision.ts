import type { Provider } from "../types.js";
import type { APIOptions } from "./builtin.js";
import { customHTTP, getPath } from "./http.js";
import { VIEError } from "../errors.js";
import { visualContent, visualPrompt } from "./visual-output.js";

/** Google generateContent API. The developer must select a vision-capable model. */
export function geminiVision(o: APIOptions): Provider {
  const structured = !!(o.structured || o.temporal);
  return customHTTP({
    id: o.id ?? "gemini-vision",
    model: o.model,
    capability: "vision",
    capabilities: {
      images: true,
      multipleImages: true,
      ocr: structured,
      objects: structured,
      activities: !!o.temporal,
      imageFormats: ["jpeg"],
      maxBytes: 10 * 1024 * 1024,
    },
    endpoint:
      o.endpoint ??
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(o.model)}:generateContent`,
    apiKey: o.apiKey
      ? { header: "x-goog-api-key", value: o.apiKey }
      : undefined,
    media: "base64",
    build: (v, request) => ({
      contents: [
        {
          role: "user",
          parts: [
            { text: visualPrompt(o, request) },
            ...(v.images as string[]).map((data) => ({
              inlineData: { mimeType: "image/jpeg", data },
            })),
          ],
        },
      ],
      ...(structured
        ? { generationConfig: { responseMimeType: "application/json" } }
        : {}),
    }),
    transform: (r) => {
      const parts = getPath(r, "candidates.0.content.parts");
      if (!Array.isArray(parts))
        throw new VIEError("MALFORMED", "Gemini returned no visual content");
      const text = parts
        .filter((p) => typeof p?.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("");
      if (!text)
        throw new VIEError("MALFORMED", "Gemini returned no visual content");
      return visualContent(text, structured);
    },
    timeoutMs: o.timeoutMs,
    cacheIdentity: o.cacheIdentity,
  });
}

/** Anthropic Messages API using inline base64 JPEG blocks, not public URLs. */
export function anthropicVision(
  o: APIOptions & { maxTokens?: number },
): Provider {
  const maxTokens = o.maxTokens ?? 2048;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1)
    throw new VIEError("CONFIG", "maxTokens must be a positive integer");
  const structured = !!(o.structured || o.temporal);
  return customHTTP({
    id: o.id ?? "anthropic-vision",
    model: o.model,
    capability: "vision",
    capabilities: {
      images: true,
      multipleImages: true,
      ocr: structured,
      objects: structured,
      activities: !!o.temporal,
      imageFormats: ["jpeg"],
      maxBytes: 5 * 1024 * 1024,
    },
    endpoint: o.endpoint ?? "https://api.anthropic.com/v1/messages",
    headers: { "anthropic-version": "2023-06-01" },
    apiKey: o.apiKey ? { header: "x-api-key", value: o.apiKey } : undefined,
    media: "base64",
    build: (v, request) => ({
      model: v.model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            ...(v.images as string[]).map((data) => ({
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data },
            })),
            { type: "text", text: visualPrompt(o, request) },
          ],
        },
      ],
    }),
    transform: (r) => {
      if (getPath(r, "stop_reason") === "max_tokens")
        throw new VIEError(
          "MALFORMED",
          "Anthropic output was truncated; increase maxTokens",
        );
      const content = getPath(r, "content");
      if (!Array.isArray(content))
        throw new VIEError("MALFORMED", "Anthropic returned no visual content");
      const text = content
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
      if (!text)
        throw new VIEError("MALFORMED", "Anthropic returned no visual content");
      return visualContent(text, structured);
    },
    timeoutMs: o.timeoutMs,
    cacheIdentity: o.cacheIdentity,
  });
}
