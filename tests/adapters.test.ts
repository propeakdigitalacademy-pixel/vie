import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openAIVision,
  openAITranscription,
  qwen,
  nemotron,
} from "../src/providers/builtin.js";
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
