import { readFile, writeFile } from "node:fs/promises";

// Lockfile metadata maintenance, not dependency installation: versions and integrity
// values remain unchanged. Never converts a blocked dependency into an allowed one.
const file = "package-lock.json";
const lock = JSON.parse(await readFile(file, "utf8"));
const write = process.argv.includes("--write");
const entries = Object.entries(lock.packages).filter(
  ([, entry]) => entry.resolved,
);
let converted = 0;
if (write) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < entries.length) {
        const [path, entry] = entries[cursor++];
        const name = path.split("node_modules/").at(-1);
        const response = await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(entry.version)}`,
          { signal: AbortSignal.timeout(30000), redirect: "error" },
        );
        if (!response.ok)
          throw new Error(
            `Public registry metadata unavailable for ${name}@${entry.version}`,
          );
        const metadata = await response.json();
        const tarball = new URL(metadata.dist.tarball);
        if (
          metadata.version !== entry.version ||
          metadata.dist.integrity !== entry.integrity
        )
          throw new Error(
            `Public artifact integrity differs for ${name}@${entry.version}; refusing to change dependency identity`,
          );
        if (tarball.origin !== "https://registry.npmjs.org")
          throw new Error(`Unexpected public tarball origin for ${name}`);
        if (entry.resolved !== tarball.href) {
          entry.resolved = tarball.href;
          converted++;
        }
      }
    }),
  );
}
for (const [path, entry] of entries) {
  const url = new URL(entry.resolved);
  if (url.origin !== "https://registry.npmjs.org")
    throw new Error(
      `Nonportable dependency URL at ${path}. Run npm run lockfile:portable after package maintenance.`,
    );
}
if (write) await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`);
console.log(
  JSON.stringify({
    publicRegistryArtifacts: entries.length,
    converted,
    integrityPreserved: true,
  }),
);
