---
name: VIE product boundaries
description: User-specified product boundaries and quality expectations for VIE Engine.
---

VIE is an independent developer-focused npm SDK and CLI, not an AI video editor. Its two primary AI capability categories are transcription and image analysis; native processing must not require a text-reasoning model.

**Why:** The user supplied this architecture as non-negotiable so consuming applications can make their own decisions from extracted evidence.

**How to apply:** Keep native processing local-first, allow vision to be disabled, make shared fallbacks opt-in, and never silently download model weights during package installation or analysis.

The user wants improvements beyond the master specification and a top-tier product for AI video understanding.

**Why:** The user explicitly requested substantial improvements and reliability beyond the supplied requirements; perfection cannot be guaranteed.

**How to apply:** Prioritize measurable accuracy, evidence and provenance, honest limitations, and real working behavior over impressive unsupported claims.

The delivery targets are the user's GitHub repository and npm, not a Replit-hosted app.

**Why:** The user explicitly corrected this distinction and asked for the files to be available on GitHub and the package released to npm.

**How to apply:** Push verified changes when the user asks for GitHub delivery. Prepare and execute only authorized npm releases; do not substitute a Replit web deployment for package publication.

The user said: "just two .MD files is enough let readme explain everything how to use it and so on plus code snippets" and "qwen-nemotron.md file isn't needed".

**Why:** The user asked to reduce the scattered project documentation.

**How to apply:** Keep public project Markdown documentation to README.md and CHANGELOG.md. Put usage, configuration and code snippets in the README, not separate topic pages.

The user's license requirement is that the project "must not be cloned except authorized by owner".

**Why:** The user chose an owner-authorization restriction rather than an open-source license.

**How to apply:** Preserve the owner-authorization terms and do not replace them with a permissive license. Do not claim public npm distribution can technically prevent copying.
