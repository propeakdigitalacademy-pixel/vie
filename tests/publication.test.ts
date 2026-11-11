import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { verifyPublished } from "../scripts/verify-published.js";

const bytes = new TextEncoder().encode("the actual tested package archive");
const expected = {
  name: "vie-engine",
  version: "0.1.0-alpha.2",
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  size: bytes.length,
};
const metadata = {
  ...expected,
  dist: {
    integrity: expected.integrity,
    tarball:
      "https://registry.npmjs.org/vie-engine/-/vie-engine-0.1.0-alpha.2.tgz",
  },
};

describe("public npm release verification", () => {
  it("requires both exact metadata and downloaded archive bytes", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(Response.json(metadata));
    fetcher.mockResolvedValueOnce(new Response(bytes));
    expect(await verifyPublished(expected, { fetcher })).toMatchObject({
      version: expected.version,
      verified: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("waits for propagation but rejects an absent requested version", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(new Response("", { status: 404 }));
    await expect(
      verifyPublished(expected, {
        fetcher,
        attempts: 2,
        delayMs: 0,
      }),
    ).rejects.toThrow("missing from public npm");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("can recover from a temporarily missing version", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(new Response("", { status: 404 }));
    fetcher.mockResolvedValueOnce(Response.json(metadata));
    fetcher.mockResolvedValueOnce(new Response(bytes));
    await expect(
      verifyPublished(expected, { fetcher, attempts: 2, delayMs: 0 }),
    ).resolves.toMatchObject({ verified: true });
  });
  it.each([
    { ...metadata, version: "0.0.0-stage" },
    { ...metadata, dist: { ...metadata.dist, integrity: "sha512-different" } },
    {
      ...metadata,
      dist: { ...metadata.dist, tarball: "https://private.example/package" },
    },
  ])(
    "rejects placeholders, mismatches, and untrusted tarball hosts",
    async (value) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(value));
      await expect(verifyPublished(expected, { fetcher })).rejects.toThrow();
    },
  );
  it("rejects substituted archive bytes even if metadata claims the correct hash", async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(Response.json(metadata));
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(expected.size)));
    await expect(verifyPublished(expected, { fetcher })).rejects.toThrow(
      "bytes do not match",
    );
  });
});
