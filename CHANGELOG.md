# Changelog

## 0.1.0-alpha.2 — release candidate

- Publish the exact tested archive and require public-registry version, checksum,
  and downloaded-byte verification before reporting a successful release.
- Avoid duplicate cross-platform check runs for release tags.

## 0.1.0-alpha.1 — unreleased

- Added Gemini and Anthropic vision adapters with inline media, structured output, and explicit model selection.
- Added opt-in timestamped multi-frame activity inference for OpenAI, Ollama, Gemini, and Anthropic, with single-still and evidence safeguards.
- Added exact-version Git tag releases to npm, verified repository metadata, and portable line endings for Windows checks.

- Added standalone ESM/CommonJS SDK and executable CLI.
- Added bounded local ingestion, metadata, audio, frame sampling and native scene detection.
- Added explicit provider contracts, custom HTTP mappings, OpenAI and local runtime adapters.
- Added opt-in configurable Qwen/Nemotron adapters without assuming an unverified live response schema.
- Added retry budgets, per-provider scheduling, circuit breakers and failure provenance.
- Added evidence-linked results, coverage gaps, partial capability results and structured search.
- Added explicit checksum-validated model artifact installation and local runtime checks.
- Added synthetic-media tests, controlled integration tests, package smoke tests and labeled native evaluation.
- Added quality CI and a blocked, explicitly gated release workflow.

### Documentation and release preparation update

- Consolidated package documentation into README.md and CHANGELOG.md; removed separate topic pages.
- Added the owner's proprietary authorization requirement for source cloning/copying.
- Included LICENSE in package contents and prepared manual npm publication using the repository's NPM_TOKEN secret.
- Kept prerelease publication separate from the latest tag and stable-release approval.

Not published by this task copy. npm publishing permission, service compatibility and live semantic accuracy still require actual verification; source authorization does not technically prevent copying a publicly downloadable npm package.
