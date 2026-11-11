---
name: Dependency lockfile portability
description: Replit package tooling can record internal mirror URLs that external CI cannot resolve.
---

After dependency maintenance in this environment, verify the committed lockfile is portable before handing work to public CI.

**Why:** The managed package installer generated lockfile tarball addresses on an internal Replit mirror, including runtime dependencies. Local cached installs passed, while a clean external checkout would not resolve that hostname. An installed-package smoke test alone did not catch a development lockfile problem.

**How to apply:** Preserve scanned dependency versions and integrity hashes. Verify public registry metadata before normalizing download addresses, then test a clean copied checkout with a fresh cache. Recheck after future package operations because tooling can reintroduce internal addresses. Never use portability normalization to bypass a blocked dependency.
