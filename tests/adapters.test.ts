import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openAIVision,
  openAITranscription,
  qwen,
  nemotron,
  ollamaVision,
} from "../src/providers/builtin.js";
import {
  geminiVision,
  anthropicVision,
} from "../src/providers/additional-vision.js";
import type { MediaRequest } from "../src/types.js";
const transport = vi.hoisted(() => vi.fn());
vi.mock("../src/security.js", async (original) => ({
  ...(await original<typeof import("../src/security.js")>()),
  secureFetch: transport,
  validateURL: async (value: string) => new URL(value),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const d of directories.splice(0))
    await rm(d, { recursive: true, force: true });
});
async function request(
  capability: "vision" | "transcription" = "vision",
): Promise<MediaRequest> {
  const dir = await mkdtemp(join(tmpdir(), "vie-adapter-"));
  directories.push(dir);
  const path = join(dir, capability === "vision" ? "frame.jpg" : "audio.wav");
  await writeFile(path, "test");
  return {
    capability,
    files: [path],
    timestamps: [0],
    duration: 1,
    prompt: "Describe visible content",
    signal: AbortSignal.timeout(1000),
  };
}
function respond(json: unknown) {
  transport.mockImplementation(async () => ({
    response: new Response(JSON.stringify(json)),
    close: async () => {},
  }));
}
describe("mocked documented built-in request and response contracts", () => {
  it("uses OpenAI chat image data URLs and normalizes a description", async () => {
    respond({ choices: [{ message: { content: "red" } }] });
    expect(
      await openAIVision({ model: "developer-selected", apiKey: "fake" }).run(
        await request(),
      ),
    ).toEqual({ description: "red" });
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(options.headers.Authorization).toBe("Bearer fake");
    expect(JSON.parse(options.body).messages[0].content[1].image_url.url).toBe(
      "data:image/jpeg;base64,dGVzdA==",
    );
  });
  it("uses OpenAI multipart audio with model-specific timestamp precision", async () => {
    respond({
      text: "hello",
      segments: [{ start: 0, end: 0.5, text: "hello" }],
    });
    expect(
      await openAITranscription({ model: "whisper-1", apiKey: "fake" }).run(
        await request("transcription"),
      ),
    ).toMatchObject({ precision: "segment" });
    expect(transport.mock.calls[0]![1].body.get("response_format")).toBe(
      "verbose_json",
    );
    respond({ text: "hello" });
    const result = await openAITranscription({
      model: "developer-selected",
    }).run(await request("transcription"));
    expect(result).toMatchObject({ segments: [], precision: "unavailable" });
    expect(transport.mock.calls.at(-1)![1].body.get("response_format")).toBe(
      "json",
    );
  });
  it("sends Gemini inline images with header authentication and joins output parts", async () => {
    respond({
      candidates: [{ content: { parts: [{ text: "red " }, { text: "box" }] } }],
    });
    expect(
      await geminiVision({ model: "chosen-model", apiKey: "fake" }).run(
        await request(),
      ),
    ).toEqual({ description: "red box" });
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/chosen-model:generateContent",
    );
    expect(options.headers["x-goog-api-key"]).toBe("fake");
    expect(url).not.toContain("fake");
    expect(JSON.parse(options.body).contents[0].parts[1]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: "dGVzdA==" },
    });
  });
  it("sends Anthropic base64 image blocks and ignores non-text response blocks", async () => {
    respond({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "not a visual result" },
        { type: "text", text: "red box" },
      ],
    });
    expect(
      await anthropicVision({ model: "chosen-model", apiKey: "fake" }).run(
        await request(),
      ),
    ).toEqual({ description: "red box" });
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.headers["x-api-key"]).toBe("fake");
    expect(options.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(options.body)).toMatchObject({
      max_tokens: 2048,
      messages: [
        {
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: "dGVzdA==",
              },
            },
            { type: "text" },
          ],
        },
      ],
    });
  });
  it.each([geminiVision, anthropicVision])(
    "rejects missing or blocked visual output rather than inventing a result",
    async (factory) => {
      respond({ error: { message: "private diagnostic" } });
      await expect(
        factory({ model: "chosen" }).run(await request()),
      ).rejects.toMatchObject({ code: "MALFORMED" });
    },
  );
  it("rejects Anthropic truncation and invalid token limits", async () => {
    respond({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: '{"description":"unfinished' }],
    });
    await expect(
      anthropicVision({ model: "chosen", structured: true }).run(
        await request(),
      ),
    ).rejects.toMatchObject({ code: "MALFORMED" });
    expect(() => anthropicVision({ model: "chosen", maxTokens: -1 })).toThrow();
  });
  it.each([
    {
      factory: openAIVision,
      response: (text: string) => ({
        choices: [{ message: { content: text } }],
      }),
    },
    { factory: ollamaVision, response: (text: string) => ({ response: text }) },
    {
      factory: geminiVision,
      response: (text: string) => ({
        candidates: [{ content: { parts: [{ text }] } }],
      }),
    },
    {
      factory: anthropicVision,
      response: (text: string) => ({ content: [{ type: "text", text }] }),
    },
  ])(
    "supports explicit ordered-frame analysis without claiming continuous coverage",
    async ({ factory, response }) => {
      const visual = {
        description: "A box appears at two different positions",
        activities: [
          { description: "The box changed position", frameIndices: [0, 1] },
        ],
      };
      respond(response(JSON.stringify(visual)));
      const req = await request();
      req.files.push(req.files[0]!);
      req.timestamps = [0, 1];
      const provider = factory({ model: "chosen", temporal: true });
      expect(provider.capabilities.activities).toBe(true);
      expect(await provider.run(req)).toEqual(visual);
      const body = JSON.parse(transport.mock.calls[0]![1].body);
      expect(JSON.stringify(body)).toContain("timestamps in seconds are [0,1]");
      expect(JSON.stringify(body)).toContain("unsampled intervals");
      expect(factory({ model: "chosen" }).capabilities.activities).not.toBe(
        true,
      );
    },
  );
  it("does not invite activity claims for a temporal batch containing one still", async () => {
    respond({ response: '{"description":"A box"}' });
    await ollamaVision({ model: "chosen", temporal: true }).run(
      await request(),
    );
    const payload = JSON.parse(transport.mock.calls[0]![1].body);
    expect(payload.prompt).toContain(
      "Do not report actions or movement from a still image",
    );
    expect(payload.prompt).not.toContain("You may include an activities array");
  });
  it.each([qwen, nemotron])(
    "requires short-lived developer delivery and invokes cleanup for a shared adapter",
    async (factory) => {
      respond({ data: { caption: "verified by mock only" } });
      const dispose = vi.fn(async () => {});
      const provider = factory({
        baseURL: "https://service.example/vision/",
        deliver: async () => ({
          url: "https://storage.example/frame?temporary=1",
          dispose,
        }),
        transform: (r) => ({ description: (r as any).data.caption }),
      });
      expect(await provider.run(await request())).toEqual({
        description: "verified by mock only",
      });
      expect(transport.mock.calls[0]![0]).toContain(
        `/vision/${provider.id.replace("shared-", "")}/analyze`,
      );
      expect(JSON.parse(transport.mock.calls[0]![1].body)).toMatchObject({
        image: "https://storage.example/frame?temporary=1",
      });
      expect(dispose).toHaveBeenCalledOnce();
    },
  );
});
