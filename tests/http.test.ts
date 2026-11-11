import { afterEach, describe, it, expect, vi } from "vitest";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { customHTTP } from "../src/providers/http.js";
import {
  ollamaVision,
  whisperCpp,
  openAIVision,
  openAITranscription,
  qwen,
  nemotron,
} from "../src/providers/builtin.js";
import { secureFetch, validateURL, isPublicIP } from "../src/security.js";
import type { MediaRequest } from "../src/types.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.restoreAllMocks();
});
async function server(handler: RequestListener) {
  const http = createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}
async function request(
  capability: "vision" | "transcription" = "vision",
): Promise<MediaRequest> {
  const dir = await mkdtemp(join(tmpdir(), "vie-http-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, capability === "vision" ? "frame.jpg" : "audio.wav");
  await writeFile(path, "controlled-test-payload");
  return {
    capability,
    files: [path],
    timestamps: [0],
    duration: 1,
    prompt: "visible evidence",
    signal: AbortSignal.timeout(3000),
  };
}
describe("real local transport, custom mappings and runtime contracts", () => {
  it("maps method, query, nested request, response, headers, auth and transformation", async () => {
    let received: any;
    const url = await server(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        key: req.headers["x-api-key"],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, data: { caption: "red surface" } }));
    });
    const p = customHTTP({
      id: "custom",
      model: "test",
      location: "local",
      capability: "vision",
      capabilities: { images: true },
      endpoint: url + "/infer",
      method: "PATCH",
      bearer: "fake-bearer",
      apiKey: { header: "X-API-Key", value: "fake-key" },
      query: { mode: "detail" },
      requestMapping: { image: "input.media", prompt: "input.question" },
      responseMapping: { description: "data.caption" },
      success: (r) => (r as any).ok === true,
      transform: (r) => ({ ...(r as any), objects: [] }),
    });
    const result = await p.run(await request());
    expect(result).toMatchObject({ description: "red surface", objects: [] });
    expect(received).toMatchObject({
      method: "PATCH",
      url: "/infer?mode=detail",
      auth: "Bearer fake-bearer",
      key: "fake-key",
    });
    expect(received.body.input.media).toBe(
      Buffer.from("controlled-test-payload").toString("base64"),
    );
    expect(received.body.input.question).toBe("visible evidence");
  });
  it("supports multipart uploads to whisper.cpp and Ollama without downloading models", async () => {
    let uploaded = "";
    const url = await server(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      uploaded = Buffer.concat(chunks).toString();
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/inference")
        res.end(
          JSON.stringify({
            text: "hello",
            segments: [{ start: 0, end: 0.5, text: "hello" }],
          }),
        );
      else res.end(JSON.stringify({ response: "red surface" }));
    });
    const transcript = await whisperCpp({ endpoint: url + "/inference" }).run(
      await request("transcription"),
    );
    expect(transcript).toMatchObject({ text: "hello", precision: "segment" });
    expect(uploaded).toContain('filename="audio.wav"');
    expect(uploaded).toContain("verbose_json");
    const vision = await ollamaVision({
      model: "developer-selected",
      endpoint: url + "/api/generate",
    }).run(await request());
    expect(vision).toMatchObject({ description: "red surface" });
    expect(JSON.parse(uploaded)).toMatchObject({
      stream: false,
      model: "developer-selected",
      images: [Buffer.from("controlled-test-payload").toString("base64")],
    });
  });
  it.each([401, 403, 429, 500, 502, 503, 504, 400, 415])(
    "classifies HTTP %s without exposing bodies",
    async (status) => {
      const url = await server((_req, res) => {
        res.statusCode = status;
        res.setHeader("Retry-After", "2");
        res.end("secret provider body");
      });
      const p = customHTTP({
        id: "custom",
        model: "test",
        capability: "vision",
        location: "local",
        capabilities: { images: true },
        endpoint: url,
      });
      const error = await p.run(await request()).catch((e) => e);
      expect(error.message).not.toContain("secret");
      expect(error.retryable).toBe([429, 500, 502, 503, 504].includes(status));
      if (status === 429)
        expect(error).toMatchObject({ code: "RATE_LIMIT", retryAfterMs: 2000 });
    },
  );
  it("rejects malformed JSON, mapped response mismatch, application errors and oversized responses", async () => {
    const url = await server((req, res) =>
      res.end(
        req.url === "/invalid"
          ? "not json"
          : JSON.stringify({ error: "sensitive", x: "a".repeat(500) }),
      ),
    );
    const base = {
      id: "custom",
      model: "test",
      capability: "vision" as const,
      location: "local" as const,
      capabilities: { images: true },
    };
    await expect(
      customHTTP({ ...base, endpoint: url + "/invalid" }).run(await request()),
    ).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(
      customHTTP({ ...base, endpoint: url }).run(await request()),
    ).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(
      customHTTP({ ...base, endpoint: url, errorPath: "error" }).run(
        await request(),
      ),
    ).rejects.toMatchObject({ code: "MALFORMED" });
    await expect(
      customHTTP({ ...base, endpoint: url, maxResponseBytes: 32 }).run(
        await request(),
      ),
    ).rejects.toMatchObject({ code: "BUDGET" });
  });
  it("times out, cancels, rejects redirects and protects prototype paths", async () => {
    const url = await server((req, res) => {
      if (req.url === "/redirect") {
        res.statusCode = 302;
        res.setHeader("Location", "http://169.254.169.254");
        res.end();
      }
    });
    const base = {
      id: "custom",
      model: "test",
      capability: "vision" as const,
      location: "local" as const,
      capabilities: { images: true },
    };
    await expect(
      customHTTP({ ...base, endpoint: url, timeoutMs: 20 }).run(
        await request(),
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(
      customHTTP({ ...base, endpoint: url + "/redirect" }).run(await request()),
    ).rejects.toMatchObject({ code: "SECURITY" });
    await expect(
      customHTTP({
        ...base,
        endpoint: url,
        requestMapping: { image: "__proto__.polluted" },
      }).run(await request()),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(
      customHTTP({ ...base, endpoint: url }).run({
        ...(await request()),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
describe("public destination security", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "100.64.0.1",
    "224.0.0.1",
  ])("rejects private/reserved address %s", (ip) =>
    expect(isPublicIP(ip)).toBe(false),
  );
  it.each([
    "http://example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://user:password@example.com",
    "file:///tmp/a",
  ])(
    "rejects unsafe URL %s",
    async (url) => await expect(validateURL(url)).rejects.toBeTruthy(),
  );
  it("does not let local mode target non-loopback destinations", async () => {
    await expect(
      secureFetch("http://192.168.1.1", { local: true }),
    ).rejects.toMatchObject({ code: "SECURITY" });
  });
});
describe("documented external adapter contracts (mocked transport)", () => {
  it("declares only verified capabilities and keeps endpoints configurable", () => {
    expect(
      openAITranscription({ model: "gpt-4o-transcribe" }).capabilities
        .timestamps,
    ).toBe(false);
    expect(
      openAITranscription({ model: "whisper-1" }).capabilities.timestamps,
    ).toBe(true);
    expect(
      openAIVision({ model: "explicit-choice" }).capabilities.activities,
    ).toBeUndefined();
    expect(() => qwen({} as any)).toThrow();
    expect(() => nemotron({} as any)).toThrow();
  });
});
