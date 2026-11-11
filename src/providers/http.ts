import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  Capabilities,
  Capability,
  MediaRequest,
  Provider,
  Transcript,
} from "../types.js";
import { boundedBody, secureFetch, validateURL } from "../security.js";
import { VIEError } from "../errors.js";
import { normalize } from "./schema.js";
export interface HTTPConfig {
  id: string;
  model: string;
  capability: Capability;
  endpoint: string;
  location?: "local" | "external";
  shared?: boolean;
  capabilities: Capabilities;
  method?: "POST" | "PUT" | "PATCH" | "GET" | "DELETE";
  headers?: Record<string, string>;
  bearer?: string;
  apiKey?: { header: string; value: string };
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  encoding?: "json" | "multipart";
  requestMapping?: Record<string, string>;
  responseMapping?: Record<string, string>;
  media?: "base64" | "data-url" | "url" | "binary";
  maxResponseBytes?: number;
  timeoutMs?: number;
  deliver?: (
    path: string,
    signal: AbortSignal,
  ) => Promise<{ url: string; dispose?: () => Promise<void> }>;
  build?: (values: Record<string, unknown>, request: MediaRequest) => unknown;
  transform?: (response: unknown, request: MediaRequest) => unknown;
  success?: (response: unknown) => boolean;
  errorPath?: string;
  cacheIdentity?: string;
}
export function getPath(value: unknown, path: string): any {
  return path
    .split(".")
    .reduce<any>(
      (v, k) =>
        v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, k)
          ? v[k]
          : undefined,
      value,
    );
}
function setPath(object: Record<string, any>, path: string, value: unknown) {
  const keys = path.split(".");
  if (keys.some((k) => ["__proto__", "prototype", "constructor"].includes(k)))
    throw new VIEError("CONFIG", "Unsafe mapping path");
  let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)!] = value;
}
export function customHTTP(c: HTTPConfig): Provider {
  return {
    id: c.id,
    model: c.model,
    capability: c.capability,
    location: c.location ?? "external",
    shared: c.shared,
    capabilities: c.capabilities,
    cacheIdentity: c.cacheIdentity,
    async run(request) {
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(c.timeoutMs ?? 30000),
      ]);
      const disposers: Array<() => Promise<void>> = [];
      let connection: Awaited<ReturnType<typeof secureFetch>> | undefined;
      try {
        if (
          request.capability === "vision" &&
          request.files.length > 1 &&
          !c.capabilities.multipleImages
        )
          throw new VIEError(
            "CONFIG",
            "Provider does not declare multiple-image support",
          );
        const media: unknown[] = [];
        for (const path of request.files) {
          const bytes = await readFile(path);
          if (bytes.length > (c.capabilities.maxBytes ?? 25 * 1024 * 1024))
            throw new VIEError(
              "BUDGET",
              "Provider media exceeds declared byte limit",
            );
          if (c.media === "url") {
            if (!c.deliver)
              throw new VIEError(
                "CONFIG",
                "URL-only provider requires developer-controlled short-lived signed URL delivery",
              );
            const delivered = await c.deliver(path, signal);
            if (delivered.dispose) disposers.push(delivered.dispose);
            await validateURL(delivered.url);
            media.push(delivered.url);
          } else if (c.media === "binary")
            media.push(
              new Blob([new Uint8Array(bytes)], {
                type:
                  request.capability === "vision" ? "image/jpeg" : "audio/wav",
              }),
            );
          else
            media.push(
              (c.media === "data-url" ? "data:image/jpeg;base64," : "") +
                bytes.toString("base64"),
            );
        }
        const values: Record<string, unknown> = {
          image: media[0],
          images: media,
          file: media[0],
          prompt: request.prompt,
          model: c.model,
          language: request.language,
          timestamps: request.timestamps,
        };
        let payload: Record<string, unknown> = { ...c.body };
        for (const [from, to] of Object.entries(
          c.requestMapping ?? {
            image: "image",
            prompt: "prompt",
            model: "model",
          },
        ))
          if (values[from] !== undefined) setPath(payload, to, values[from]);
        if (c.build)
          payload = c.build(values, request) as Record<string, unknown>;
        const headers: Record<string, string> = { ...c.headers };
        if (c.bearer) headers.Authorization = `Bearer ${c.bearer}`;
        if (c.apiKey) headers[c.apiKey.header] = c.apiKey.value;
        const url = new URL(c.endpoint);
        for (const [key, value] of Object.entries(c.query ?? {}))
          url.searchParams.set(key, value);
        let body: string | FormData | undefined;
        if ((c.method ?? "POST") === "GET") {
          for (const [key, value] of Object.entries(payload))
            url.searchParams.set(
              key,
              typeof value === "string" ? value : JSON.stringify(value),
            );
        } else if (c.encoding === "multipart") {
          body = new FormData();
          for (const [key, value] of Object.entries(payload)) {
            if (value === undefined) continue;
            if (value instanceof Blob)
              body.append(
                key,
                value,
                basename(request.files[0] ?? "audio.wav"),
              );
            else if (Array.isArray(value))
              for (const entry of value) body.append(key, String(entry));
            else
              body.append(
                key,
                typeof value === "string" ? value : JSON.stringify(value),
              );
          }
        } else {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(payload);
        }
        connection = await secureFetch(url.toString(), {
          method: c.method ?? "POST",
          headers,
          body,
          signal,
          local: c.location === "local",
        });
        const r = connection.response;
        const raw = await boundedBody(
          r,
          c.maxResponseBytes ?? 2 * 1024 * 1024,
          signal,
        );
        if (!r.ok) {
          const retryAfter = r.headers.get("retry-after");
          const delay = retryAfter
            ? /^\d+(\.\d+)?$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Math.max(0, Date.parse(retryAfter) - Date.now())
            : undefined;
          throw new VIEError(
            r.status === 401 || r.status === 403
              ? "AUTH"
              : r.status === 429
                ? "RATE_LIMIT"
                : "NETWORK",
            `Provider request failed (HTTP ${r.status})`,
            [429, 500, 502, 503, 504].includes(r.status),
            delay,
          );
        }
        let json: unknown;
        try {
          json = JSON.parse(raw.toString());
        } catch {
          throw new VIEError("MALFORMED", "Provider did not return valid JSON");
        }
        if (c.success && !c.success(json))
          throw new VIEError("MALFORMED", "Provider success validation failed");
        // Extract error presence, never return its untrusted contents.
        if (c.errorPath && getPath(json, c.errorPath))
          throw new VIEError(
            "MALFORMED",
            "Provider reported an application error",
          );
        let result: unknown = json;
        if (c.responseMapping) {
          const mapped: Record<string, unknown> = {};
          for (const [target, source] of Object.entries(c.responseMapping))
            setPath(mapped, target, getPath(json, source));
          result = mapped;
        }
        if (c.transform) result = c.transform(result, request);
        return normalize(result, request);
      } catch (error) {
        if (request.signal.aborted)
          throw new VIEError("CANCELLED", "Provider operation cancelled");
        if (signal.aborted)
          throw new VIEError("TIMEOUT", "Provider request timed out", true);
        if (error instanceof VIEError) throw error;
        throw new VIEError(
          "NETWORK",
          "Provider connection or adapter failed",
          true,
        );
      } finally {
        await connection?.close();
        for (const dispose of disposers)
          await dispose().catch(() => {
            /* cleanup must not replace the provider result */
          });
      }
    },
  };
}
export function asTranscript(raw: any): Transcript {
  if (!raw || typeof raw.text !== "string")
    throw new VIEError("MALFORMED", "Missing transcript text");
  const segments = Array.isArray(raw.segments)
    ? raw.segments.map((s: any) => ({
        start: s.start,
        end: s.end,
        text: s.text,
        speaker: s.speaker,
        confidence: s.confidence,
        words: s.words,
      }))
    : [];
  return {
    text: raw.text,
    language: raw.language,
    segments,
    precision: segments.length ? "segment" : "unavailable",
  };
}
