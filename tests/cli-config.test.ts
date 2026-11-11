import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/cli-config.js";
import { configure } from "../src/config.js";
describe("data-only CLI configuration", () => {
  it("validates adapter definitions without making requests or printing keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vie-config-"));
    const file = join(dir, "config.json");
    try {
      await writeFile(
        file,
        JSON.stringify({
          vision: {
            policy: "local-only",
            providers: [{ adapter: "ollama", model: "installed" }],
          },
        }),
      );
      const config = configure(await loadConfig(file));
      expect(config.vision.providers[0]!.location).toBe("local");
      for (const adapter of ["gemini", "anthropic"]) {
        await writeFile(
          file,
          JSON.stringify({
            actions: true,
            vision: {
              providers: [{ adapter, model: "explicit", temporal: true }],
            },
          }),
        );
        const loaded = configure(await loadConfig(file));
        expect(loaded.vision.providers[0]!.capabilities.activities).toBe(true);
        expect(loaded.vision.providers[0]!.location).toBe("external");
      }
      await writeFile(
        file,
        JSON.stringify({ vision: { providers: [{ adapter: "unknown" }] } }),
      );
      await expect(loadConfig(file)).rejects.toMatchObject({ code: "CONFIG" });
      await writeFile(
        file,
        JSON.stringify({
          vision: {
            providers: [
              {
                adapter: "openai-vision",
                model: "explicit",
                apiKeyEnv: "VIE_TEST_DEFINITELY_UNSET",
              },
            ],
          },
        }),
      );
      await expect(loadConfig(file)).rejects.toMatchObject({ code: "CONFIG" });
      await writeFile(file, "malformed");
      await expect(loadConfig(file)).rejects.toMatchObject({ code: "CONFIG" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
