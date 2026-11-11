import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const script = resolve("scripts/release-gate.mjs");
async function check(
  options: {
    version?: string;
    requested?: string;
    approved?: boolean;
    stable?: boolean;
    license?: string;
    private?: boolean;
    event?: string;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "vie-release-"));
  try {
    const version = options.version ?? "0.1.0-alpha.1";
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "vie-engine",
        version,
        private: options.private ?? false,
        license: "SEE LICENSE IN LICENSE",
      }),
    );
    await writeFile(
      join(dir, "release-readiness.json"),
      JSON.stringify({
        licenseApproved: options.approved ?? true,
        stableReleaseApproved: options.stable ?? false,
      }),
    );
    await writeFile(
      join(dir, "LICENSE"),
      options.license ?? (await readFile("LICENSE", "utf8")),
    );
    const output = join(dir, "workflow-output");
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        REQUESTED_VERSION: options.requested ?? version,
        RELEASE_EVENT: options.event ?? "workflow_dispatch",
        GITHUB_OUTPUT: output,
      },
    });
    return {
      ...result,
      workflowOutput: await readFile(output, "utf8").catch(() => ""),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
describe("owner-approved release preparation without publication", () => {
  it("allows the authorized alpha channel without marking stable readiness approved", async () => {
    const result = await check();
    expect(result.status).toBe(0);
    expect(result.workflowOutput).toBe("tag=alpha\n");
    expect(JSON.parse(result.stdout).note).toContain("does not publish");
  });
  it("blocks stable releases until their separate approval", async () => {
    expect((await check({ version: "1.0.0" })).status).not.toBe(0);
    const stable = await check({ version: "1.0.0", stable: true });
    expect(stable.status).toBe(0);
    expect(stable.workflowOutput).toBe("tag=latest\n");
  });
  it("accepts an exact version tag but rejects mismatched release tags", async () => {
    expect(
      (await check({ event: "push", requested: "v0.1.0-alpha.1" })).status,
    ).toBe(0);
    expect(
      (await check({ event: "push", requested: "v0.2.0" })).status,
    ).not.toBe(0);
    expect((await check({ requested: "v0.1.0-alpha.1" })).status).not.toBe(0);
  });
  it.each([
    { approved: false },
    { license: "unapproved terms" },
    { private: true },
    { requested: "1.0.0" },
    { version: "invalid" },
  ])(
    "blocks missing approval, license, private metadata or version mismatch: %j",
    async (options) => {
      expect((await check(options)).status).not.toBe(0);
    },
  );
  it("keeps exactly two project documentation files and the owner license", async () => {
    const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
    expect(packageJSON.files).not.toContain("docs");
    expect(packageJSON.files).toEqual(
      expect.arrayContaining(["README.md", "CHANGELOG.md", "LICENSE"]),
    );
    const readme = await readFile("README.md", "utf8");
    expect(readme).not.toMatch(/\]\(docs\//);
    expect(await readFile("LICENSE", "utf8")).toContain("clone, mirror, copy");
  });
});
