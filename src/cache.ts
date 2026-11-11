import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
export function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
/** Credentials never enter keys. Explicit namespace separates tenants and authorization scopes. */
export class DiskCache {
  constructor(private dir?: string) {}
  async get<T>(key: string): Promise<T | undefined> {
    if (!this.dir) return;
    try {
      return JSON.parse(
        await readFile(join(this.dir, `${digest(key)}.json`), "utf8"),
      ) as T;
    } catch {
      return;
    }
  }
  async set(key: string, value: unknown) {
    if (!this.dir) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = join(this.dir, `${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, join(this.dir, `${digest(key)}.json`));
    } finally {
      await rm(temp, { force: true });
    }
  }
  async clear() {
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
