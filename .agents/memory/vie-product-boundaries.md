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
