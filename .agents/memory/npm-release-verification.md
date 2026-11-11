---
name: Public npm release verification
description: Why VIE publication must be verified against registry metadata and downloadable package bytes.
---

Do not report npm availability from a successful GitHub publish step alone. Verify the requested version, archive integrity, downloaded bytes, SDK imports, and CLI.

**Why:** A successful release was initially followed by public registry responses exposing only a staging placeholder. Metadata appeared before a previously requested tarball URL stopped returning a cached 404; a cache-busted download and checksum verification established actual availability.

**How to apply:** Allow bounded registry propagation time and avoid reusing negatively cached probes. Distinguish workflow success, public metadata availability, and successful package installation. Never call a placeholder package the completed engine.

Keep FFmpeg-heavy test files within a bounded worker count.

**Why:** Running the native media suites concurrently caused existing cases to exceed their per-test timeout; the same suite passed with one test worker without increasing its timeouts.

**How to apply:** Preserve resource isolation when changing test configuration. Native process scheduling and HTTP-provider concurrency are separate concerns.
