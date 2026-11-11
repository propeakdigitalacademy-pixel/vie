import { readFile } from "node:fs/promises";
import type { VIEConfig, Provider } from "./types.js";
import {
  openAIVision,
  openAITranscription,
  ollamaVision,
  whisperCpp,
} from "./providers/builtin.js";
import { customHTTP } from "./providers/http.js";
import {
  geminiVision,
  anthropicVision,
} from "./providers/additional-vision.js";
import { VIEError } from "./errors.js";
/** Data-only JSON config. No evaluation of JavaScript or shell commands. */
export async function loadConfig(path?: string): Promise<VIEConfig> {
  if (!path) return {};
  let raw: any;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new VIEError("CONFIG", "Cannot read configuration JSON");
  }
  for (const cap of ["vision", "transcription"])
    if (raw[cap]?.providers) {
      raw[cap].providers = raw[cap].providers.map((item: any): Provider => {
        const { adapter, apiKeyEnv, ...options } = item;
        const key = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
        if (apiKeyEnv && !key)
          throw new VIEError(
            "CONFIG",
            "Required provider credential environment variable is missing",
          );
        options.apiKey = key ?? options.apiKey;
        switch (adapter) {
          case "openai-vision":
            return openAIVision(options);
          case "openai-transcription":
            return openAITranscription(options);
          case "gemini":
            return geminiVision(options);
          case "anthropic":
            return anthropicVision(options);
          case "ollama":
            return ollamaVision(options);
          case "whisper.cpp":
            return whisperCpp(options);
          case "custom": {
            delete options.apiKey;
            return customHTTP({ ...options, bearer: key ?? options.bearer });
          }
          default:
            throw new VIEError(
              "CONFIG",
              "Unknown adapter in configuration file",
            );
        }
      });
    }
  return raw as VIEConfig;
}
