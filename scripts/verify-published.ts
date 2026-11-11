import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface ExpectedPackage {
  name: string;
  version: string;
  integrity: string;
  size: number;
}

/** Check the public registry and downloaded bytes, not just npm's exit code. */
export async function verifyPublished(
  expected: ExpectedPackage,
  options: {
    fetcher?: typeof fetch;
    attempts?: number;
    delayMs?: number;
  } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  // npm/CDN negative-cache entries can persist for five minutes.
  const attempts = options.attempts ?? 36;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetcher(
      `https://registry.npmjs.org/${encodeURIComponent(expected.name)}/${encodeURIComponent(expected.version)}?verify=${attempt}`,
      {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (response.status === 404) {
      if (attempt + 1 < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.delayMs ?? 10000),
        );
        continue;
      }
      throw new Error(
        `Publication unverified: ${expected.name}@${expected.version} is missing from public npm`,
      );
    }
    if (!response.ok)
      throw new Error(`Public registry check failed: HTTP ${response.status}`);
    const metadata = await response.json();
    if (
      metadata.name !== expected.name ||
      metadata.version !== expected.version ||
      metadata.dist?.integrity !== expected.integrity
    )
      throw new Error(
        "Public package identity or integrity does not match the tested archive",
      );
    const url = new URL(metadata.dist.tarball);
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org")
      throw new Error(
        "Public tarball must be hosted on the official npm registry",
      );
    url.searchParams.set("verify", `${expected.version}-${attempt}`);
    const tarball = await fetcher(url, {
      headers: { "Cache-Control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (tarball.status === 404 && attempt + 1 < attempts) {
      await tarball.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, options.delayMs ?? 10000),
      );
      continue;
    }
    if (!tarball.ok || !tarball.body)
      throw new Error("Published package tarball is unavailable");
    const hash = createHash("sha512");
    const reader = tarball.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > expected.size)
          throw new Error("Published tarball exceeds the tested archive size");
        hash.update(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (
      size !== expected.size ||
      `sha512-${hash.digest("base64")}` !== expected.integrity
    )
      throw new Error(
        "Downloaded public package bytes do not match the tested archive",
      );
    return {
      name: expected.name,
      version: expected.version,
      verified: true,
      bytes: size,
    };
  }
  throw new Error("Public registry verification requires at least one attempt");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [packed] = JSON.parse(
    await readFile(process.argv[2] ?? "release-package.json", "utf8"),
  );
  console.log(JSON.stringify(await verifyPublished(packed)));
}
