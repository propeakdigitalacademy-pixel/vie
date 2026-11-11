import { readFileSync, appendFileSync } from "node:fs";
const p = JSON.parse(readFileSync("package.json", "utf8"));
const ready = JSON.parse(readFileSync("release-readiness.json", "utf8"));
const failures = [];
if (p.private) failures.push("package is private");
if (p.license !== "SEE LICENSE IN LICENSE")
  failures.push("package must reference the owner-approved LICENSE file");
let license = "";
try {
  license = readFileSync("LICENSE", "utf8");
} catch {
  failures.push("LICENSE file is missing");
}
if (
  !license.includes("Owner Authorization License") ||
  !license.includes("explicit prior written authorization")
)
  failures.push("owner-authorization license terms are missing");
if (!ready.licenseApproved) failures.push("license is not approved");
const versionMatch = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?$/.exec(p.version);
if (!versionMatch)
  failures.push("package version must be a supported semantic version");
const prerelease = !!versionMatch?.[1];
if (!prerelease && !ready.stableReleaseApproved)
  failures.push("stable release evidence has not been approved");
const requested =
  process.env.RELEASE_EVENT === "push"
    ? process.env.REQUESTED_VERSION?.replace(/^v/, "")
    : process.env.REQUESTED_VERSION;
if (!requested || p.version !== requested)
  failures.push("requested version must equal package version");
if (failures.length)
  throw new Error(`Publication blocked: ${failures.join("; ")}`);
const tag = prerelease ? "alpha" : "latest";
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
console.log(
  JSON.stringify({
    version: p.version,
    tag,
    licenseApproved: true,
    note: "Publication requires an explicit workflow request or version tag and npm publishing permission; this check does not publish.",
  }),
);
