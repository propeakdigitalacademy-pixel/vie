import type { Provider } from "../types.js";
import { customHTTP, asTranscript, type HTTPConfig, getPath } from "./http.js";
import { VIEError } from "../errors.js";
export interface APIOptions {
  model: string;
  apiKey?: string;
  endpoint?: string;
  id?: string;
  timeoutMs?: number;
  cacheIdentity?: string;
  structured?: boolean;
}
const structuredPrompt =
  "Return only JSON with a description string, optional objects array of {label}, optional text array of {text}, optional environment and composition strings. Describe only visible evidence. Do not report actions or movement from still images. Do not invent confidence values.";
function visualContent(value: unknown, structured?: boolean) {
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
/** Model must be explicitly selected. Timestamp support is not assumed for arbitrary models. */
export function openAITranscription(o: APIOptions): Provider {
  const whisper = o.model === "whisper-1";
  return customHTTP({
    id: o.id ?? "openai-transcription",
    model: o.model,
    capability: "transcription",
    capabilities: { timestamps: whisper },
    endpoint: o.endpoint ?? "https://api.openai.com/v1/audio/transcriptions",
    bearer: o.apiKey,
    encoding: "multipart",
    media: "binary",
    requestMapping: { file: "file", model: "model", language: "language" },
    body: { response_format: whisper ? "verbose_json" : "json" },
    transform: asTranscript,
    timeoutMs: o.timeoutMs,
    cacheIdentity: o.cacheIdentity,
  });
}
export function openAIVision(o: APIOptions): Provider {
  return customHTTP({
    id: o.id ?? "openai-vision",
    model: o.model,
    capability: "vision",
    capabilities: {
      images: true,
      multipleImages: true,
      ocr: !!o.structured,
      objects: !!o.structured,
      imageFormats: ["jpeg"],
    },
    endpoint: o.endpoint ?? "https://api.openai.com/v1/chat/completions",
    bearer: o.apiKey,
    media: "data-url",
    build: (v) => ({
      model: v.model,
      ...(o.structured ? { response_format: { type: "json_object" } } : {}),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: o.structured
                ? `${v.prompt}\n${structuredPrompt}`
                : v.prompt,
            },
            ...(v.images as string[]).map((url) => ({
              type: "image_url",
              image_url: { url },
            })),
          ],
        },
      ],
    }),
    transform: (r) =>
      visualContent(getPath(r, "choices.0.message.content"), o.structured),
    timeoutMs: o.timeoutMs,
    cacheIdentity: o.cacheIdentity,
  });
}
export function ollamaVision(o: APIOptions): Provider {
  return customHTTP({
    id: o.id ?? "ollama",
    model: o.model,
    location: "local",
    capability: "vision",
    capabilities: {
      images: true,
      multipleImages: true,
      ocr: !!o.structured,
      objects: !!o.structured,
      imageFormats: ["jpeg"],
    },
    endpoint: o.endpoint ?? "http://127.0.0.1:11434/api/generate",
    bearer: o.apiKey,
    media: "base64",
    build: (v) => ({
      model: v.model,
      images: v.images,
      prompt: o.structured ? `${v.prompt}\n${structuredPrompt}` : v.prompt,
      stream: false,
      ...(o.structured ? { format: "json" } : {}),
    }),
    transform: (r) => visualContent(getPath(r, "response"), o.structured),
    timeoutMs: o.timeoutMs,
    cacheIdentity: o.cacheIdentity,
  });
}
export function whisperCpp(
  o: Omit<APIOptions, "model"> & { model?: string } = {},
): Provider {
  return customHTTP({
    id: o.id ?? "whisper.cpp",
    model: o.model ?? "runtime-loaded-model",
    location: "local",
    capability: "transcription",
    capabilities: { timestamps: true },
    endpoint: o.endpoint ?? "http://127.0.0.1:8080/inference",
    bearer: o.apiKey,
    encoding: "multipart",
    media: "binary",
    body: { response_format: "verbose_json" },
    requestMapping: { file: "file", language: "language" },
    transform: asTranscript,
    cacheIdentity: o.cacheIdentity,
  });
}
export interface SharedOptions {
  baseURL?: string;
  deliver: NonNullable<HTTPConfig["deliver"]>;
  transform: NonNullable<HTTPConfig["transform"]>;
  route?: "analyze" | "describe" | "caption" | "ocr" | "tags";
  model?: string;
}
function shared(name: "qwen" | "nemotron", o: SharedOptions): Provider {
  if (!o.deliver || !o.transform)
    throw new VIEError(
      "CONFIG",
      "Shared service requires explicit delivery and verified response transformation",
    );
  const base = o.baseURL ?? "https://apispec.litype.workers.dev/visionai/";
  return customHTTP({
    id: `shared-${name}`,
    model: o.model ?? "service-selected-unverified",
    shared: true,
    capability: "vision",
    capabilities: { images: true },
    endpoint: `${base.replace(/\/?$/, "/")}${name}/${o.route ?? "analyze"}`,
    media: "url",
    deliver: o.deliver,
    requestMapping: { image: "image", prompt: "prompt" },
    transform: o.transform,
  });
}
export const qwen = (o: SharedOptions) => shared("qwen", o);
export const nemotron = (o: SharedOptions) => shared("nemotron", o);
export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  register(provider: Provider): this {
    if (this.providers.has(provider.id))
      throw new VIEError("CONFIG", "Provider already registered");
    this.providers.set(provider.id, provider);
    return this;
  }
  get(id: string): Provider {
    const p = this.providers.get(id);
    if (!p) throw new VIEError("CONFIG", "Provider not registered");
    return p;
  }
  list(): Provider[] {
    return [...this.providers.values()];
  }
}
