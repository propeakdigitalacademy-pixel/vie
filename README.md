# VIE Engine

Standalone, local-first **Video Intelligence Engine** for Node.js: extract video metadata, audio, scenes, timestamped frames, transcripts and visual evidence without an editor, database or mandatory reasoning model.

**Status:** alpha. Native processing is verified with real FFmpeg media. Provider contracts have deterministic tests; live model accuracy and shared-service availability are not guaranteed. Nothing has been published by this task copy.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Metadata, scenes, frames and audio](#metadata-scenes-frames-and-audio)
- [Transcription and vision providers](#transcription-and-vision-providers)
- [Custom endpoints and plugins](#custom-endpoints-and-plugins)
- [Local models](#local-models)
- [Fallbacks and privacy policies](#fallbacks-and-privacy-policies)
- [Configuration](#configuration)
- [Results, evidence and search](#results-evidence-and-search)
- [CLI](#cli)
- [Budgets, progress and cancellation](#budgets-progress-and-cancellation)
- [Caching and errors](#caching-and-errors)
- [Security and limitations](#security-and-limitations)
- [Development and verification](#development-and-verification)
- [Releasing to npm](#releasing-to-npm)
- [License](#license)

## Installation

Requirements: **Node.js 20.3+**, **FFmpeg 5+ and FFprobe 5+**. Install FFmpeg separately using your operating system's package manager and put both binaries on PATH. Package development uses Node 24.

For an authorized npm release:

```sh
npm install vie-engine
npx vie --help
```

Until a release has actually been published, install a local tarball instead:

```sh
# Only clone/copy the source with the owner's authorization.
npm ci
npm run build
npm pack
# In your consuming application:
npm install /absolute/path/to/vie-engine-0.1.0-alpha.1.tgz
```

Installation does **not** download models, install FFmpeg or start background services. There is no postinstall hook. Runtime dependencies are Commander, ipaddr.js, Undici and Zod.

For custom binary locations:

```js
const vie = new VIE({
  ffmpeg: "/path/to/ffmpeg",
  ffprobe: "/path/to/ffprobe",
});
await vie.status();
```

`VIE_FFMPEG` and `VIE_FFPROBE` also override default binary names. Programmatic configuration takes precedence.

## Quick start

Both AI capabilities are **disabled by default**. Native processing needs no API key or model.

```js
import { VIE } from "vie-engine";

const vie = new VIE({
  maxDuration: 600,
  sampling: { mode: "scene", maxFrames: 12 },
});
const result = await vie.analyze("./video.mp4");
console.log(result.metadata, result.scenes, result.coverage);
```

CommonJS:

```js
const { VIE } = require("vie-engine");
```

Input may be a regular file path, Buffer, Node Readable, Blob/File, or explicitly enabled HTTPS URL:

```js
const result = await new VIE({
  allowRemote: true,
  maxInputBytes: 100 * 1024 * 1024,
}).analyze("https://your-public-host.example/video.mp4");
```

Remote downloads require public HTTPS destinations and reject redirects. Private-network URLs and credentials embedded in URLs are forbidden.

## Metadata, scenes, frames and audio

```js
const metadata = await vie.getMetadata("./video.mp4");
const scenes = await vie.getScenes("./video.mp4");

const extracted = await vie.extractFrames("./video.mp4");
try {
  for (const frame of extracted.frames) {
    console.log(frame.timestamp, frame.sourceTimestamp, frame.path);
  }
} finally {
  await extracted.cleanup();
}

const single = await vie.getFrame("./video.mp4", 1.25);
try {
  console.log(single.frame);
} finally {
  await single.cleanup();
}

const audio = await vie.extractAudio("./video.mp4");
try {
  console.log(audio.path); // mono 16 kHz PCM WAV
} finally {
  await audio.cleanup();
}
```

Extraction methods return caller-owned output plus a cleanup function. Ordinary `analyze()` deletes temporary media and removes stale file paths from its result. With `retain: true`, the caller owns cleanup of retained media. Failures still clean up.

Metadata includes available duration, size, container, codecs, geometry, aspect ratio, nominal/average FPS, pixel format, bitrate, audio sample rate/channels, rotation, stream count and source start time. Missing fields are absent, not guessed. `metadata.raw` preserves FFprobe details and may contain private source tags.

Scenes use FFmpeg visual-change scoring (`sceneThreshold`, default 0.3), not a model. Lower thresholds generally detect more changes; this is not semantic story segmentation.

### Sampling

```js
const vie = new VIE({
  sampling: {
    mode: "custom",
    timestamps: [0, 1.25, 3],
    maxFrames: 12,
    maxDimension: 1024,
    quality: 3,
  },
});
```

| Mode                      | Behavior                                                          |
| ------------------------- | ----------------------------------------------------------------- |
| `fixed`                   | Sample every `interval` seconds, starting at zero                 |
| `fps`                     | Sample at `1 / fps` second intervals                              |
| `scene`                   | Scene midpoints                                                   |
| `custom`                  | Unique in-range `timestamps`                                      |
| `first`, `middle`, `last` | A single selected position                                        |
| `adaptive`                | Scene edges, nearby dense samples, midpoints and fixed candidates |

Candidate generation and output are bounded by `maxFrames`. Selection favors earliest ordered candidates; it does not imply full-video coverage. JPEG quality is FFmpeg qscale 2–31: lower is higher quality.

Frames retain actual decoded PTS, source offsets, dimensions and scene references. Precise frame numbers are not guessed from average FPS. Oversampled duplicate timestamps are deduplicated. Adaptive sampling is not optical flow.

## Transcription and vision providers

Running an external-provider configuration explicitly permits sending extracted media to that provider and may incur charges. Select real model IDs supported by your account; VIE does not choose a paid model for you.

```js
import { VIE, openAITranscription, openAIVision } from "vie-engine";

if (
  !process.env.OPENAI_API_KEY ||
  !process.env.SPEECH_MODEL ||
  !process.env.VISION_MODEL
) {
  throw new Error("Configure credentials and actual supported model IDs");
}

const vie = new VIE({
  transcription: {
    providers: [
      openAITranscription({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.SPEECH_MODEL,
      }),
    ],
  },
  vision: {
    providers: [
      openAIVision({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.VISION_MODEL,
        structured: true,
      }),
    ],
  },
  maxRequests: 20,
  maxRetries: 1,
  sampling: { mode: "scene", maxFrames: 6 },
});
const result = await vie.analyze("./video.mp4");
```

`structured: true` requests normalized descriptions, objects, OCR, environment and composition. OpenAI's selected model must support JSON-object response format. Without structured mode, built-in vision adapters return descriptions only.

| Factory               | Contract and limits                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `openAITranscription` | Multipart `/audio/transcriptions`; `whisper-1` uses `verbose_json`; other model IDs use JSON without presumed timestamps |
| `openAIVision`        | Chat completions with image data URLs; optional structured JSON                                                          |
| `ollamaVision`        | Loopback `/api/generate`, base64 images, nonstreaming; optional structured JSON                                          |
| `whisperCpp`          | Loopback `/inference`, multipart WAV, `verbose_json`                                                                     |
| `qwen`, `nemotron`    | Separate opt-in configurable URL-only shared adapters requiring delivery and response transformation                     |

The factories accept explicit `id`, `model`, optional `apiKey`, `endpoint`, `timeoutMs`, and versioned `cacheIdentity` where applicable. Availability, pricing and model capabilities can change.

Transcription is chunked using `audioChunkSeconds` (default 120, maximum 600). Segment and word times are validated against the chunk and shifted to the video timeline. Plain text is assigned only a **chunk** range, not invented word/segment precision. Language, speakers, confidence and words are included only when supplied. Speaker identity is not established across independent chunks.

```js
const speech = await vie.getTranscript("./video.mp4");
console.log(speech.status, speech.transcript, speech.warnings);
```

Deepgram, AssemblyAI, Gemini and Anthropic are not advertised as built-in integrations in this alpha. Use tested custom endpoints/plugins for additional services.

## Custom endpoints and plugins

```js
import { customHTTP, VIE } from "vie-engine";

const provider = customHTTP({
  id: "my-ocr",
  model: "my-deployment",
  capability: "vision",
  endpoint: "https://your-service.example/analyze",
  bearer: process.env.CUSTOM_KEY,
  capabilities: { images: true, ocr: true, objects: true },
  method: "POST",
  media: "base64",
  requestMapping: { image: "input.jpeg", prompt: "input.question" },
  responseMapping: {
    description: "data.caption",
    text: "data.lines",
    objects: "data.objects",
  },
});
const result = await new VIE({
  vision: { providers: [provider] },
}).analyze("./video.mp4");
```

Expected normalized OCR items are `{text, confidence?}`; object items are `{label, confidence?}`.

Supported configuration:

- HTTP methods POST/GET/PUT/PATCH/DELETE; headers, query fields, bearer auth or `apiKey: {header,value}`.
- JSON or `encoding: 'multipart'`; `media` can be base64, data-url, binary Blob or URL.
- Static `body` plus source-to-destination nested `requestMapping`.
- Available source variables: `image`, `images`, `file`, `prompt`, `model`, `language`, `timestamps`.
- Dotted own-property `responseMapping`, including numeric array indices.
- `build(values,request)` for a custom body, `transform(response,request)` for normalization, `success(response)` for application validation, and `errorPath` for error presence without leaking its contents.
- Bounded response bytes (`maxResponseBytes`, default 2 MiB), timeouts and AbortSignal.

Prototype-related mapping paths are forbidden. GET mappings become query values; avoid sensitive payloads in query strings because upstream services may log them.

Programmatic `Provider` plugins implement `run(MediaRequest)` with explicit ID, model, capability, location and capability declarations. `ProviderRegistry` supports register/get/list. Plugins and callbacks are trusted code, not sandboxed. A location label cannot prevent a malicious plugin from performing arbitrary I/O.

## Local models

VIE connects to existing runtimes; it never starts servers or pulls models during analysis.

```js
import { VIE, ollamaVision, whisperCpp, runtimeStatus } from "vie-engine";

const vie = new VIE({
  vision: {
    policy: "local-only",
    providers: [
      ollamaVision({
        model: "YOUR_ALREADY_INSTALLED_IMAGE_MODEL",
        structured: true,
      }),
    ],
  },
  transcription: {
    policy: "local-only",
    providers: [whisperCpp({ model: "YOUR_LOADED_WHISPER_MODEL" })],
  },
});
console.log(await runtimeStatus("http://127.0.0.1:11434", "ollama"));
```

Ollama status lists runtime-reported tags, not proof of vision compatibility or GPU capacity. whisper.cpp status checks HTTP reachability, not a loaded model. Start `whisper-server` separately and bind it to loopback. Use custom local HTTP adapters for compatible faster-whisper or other servers.

### Explicit artifact installation

```js
import { ModelManager } from "vie-engine";

const models = new ModelManager("./private-models");
// Read a verified distributor manifest; never invent its hash or license.
await models.install(manifest, { confirmed: true });
console.log(await models.list());
console.log(await models.inspect(manifest.id)); // Re-check artifact integrity
await models.remove(manifest.id, true);
```

A manifest requires:

| Field            | Meaning                                               |
| ---------------- | ----------------------------------------------------- |
| `id`, `name`     | Path-safe identifier and display name                 |
| `url`            | Actual public HTTPS artifact URL; redirects forbidden |
| `bytes`          | Exact positive artifact byte size                     |
| `sha256`         | Actual 64-character artifact checksum                 |
| `runtime`        | `whisper.cpp`, `ollama` or `custom`                   |
| `license`        | Actual distributor license                            |
| `minMemoryBytes` | Optional declared RAM requirement                     |

CLI installation shows the model name, size and declared RAM before confirmation. Noninteractive callers must pass `--yes`. Downloads stream to private temporary files, check storage/RAM, validate size/hash and record metadata with the URL redacted. Existing model IDs cannot be silently overwritten; remove them explicitly first.

Default storage is `~/.vie/models`; use SDK directory or CLI `--model-dir` to override. Artifact installation does not install a runtime, import an Ollama model or certify GPU/acceleration compatibility. Hardware reporting does not invent GPU capabilities.

## Fallbacks and privacy policies

Policies apply independently to transcription and vision:

| Policy       | Behavior                                                          |
| ------------ | ----------------------------------------------------------------- |
| `disabled`   | No provider or delivery callback                                  |
| `strict`     | Original primary only                                             |
| `user-only`  | Primary then developer backups, never shared                      |
| `automatic`  | Configured order, including explicitly permitted shared adapters  |
| `local-only` | Local providers only; built-in/custom local HTTP is loopback-only |

Providing a capability object without a policy defaults it to user-only. No providers yields `unconfigured`.

```js
const vie = new VIE({
  vision: { policy: "user-only", providers: [primaryVision, backupVision] },
  transcription: { policy: "strict", providers: [primarySpeech] },
});
```

For shared vision fallback, order providers as primary, developer backups, Qwen, Nemotron unless you intentionally choose another order. Both `policy: 'automatic'` and `sharedFallbackEnabled: true` are required.

`qwen()` and `nemotron()` each require:

- A developer-controlled `deliver(path,signal)` callback returning `{url,dispose?}` using a short-lived signed URL.
- A `transform(response,request)` matching the actual verified response schema.
- Optional `baseURL`, `route` and model provenance configuration.

No original video is sent to shared endpoints. Local files are never automatically exposed through permanent public hosting.

**Service caveat:** the supplied `/visionai/...` contract differs from `/vision/...` advertised by the observed health directory. No private media was sent to verify inference. Configure and verify the actual routes and transforms before relying on them. A successful health request is not model verification.

## Configuration

Main options:

| Group       | Options                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Media       | `ffmpeg`, `ffprobe`, `tempDir`, `retain`, `allowRemote`, `maxInputBytes`, `maxDuration`                                                      |
| Sampling    | `sampling`, `sceneThreshold`                                                                                                                 |
| AI          | `vision`, `transcription`, `sharedFallbackEnabled`, `language`, `audioChunkSeconds`, `ocr`, `objects`, `actions`                             |
| Reliability | `maxRequests`, `maxRetries`, `retryBudget`, `concurrency`, `timeoutMs`, `backoffMs`, `circuitThreshold`, `circuitRecoveryMs`, `maxRuntimeMs` |
| Efficiency  | `cacheDir`, `cacheNamespace`, `pricing`                                                                                                      |
| Progress    | `onProgress`                                                                                                                                 |

Configuration is strict: unknown fields and invalid numeric bounds are rejected. Precedence is explicit programmatic/CLI JSON settings, then binary environment overrides, then defaults. No `.env` file is automatically executed or loaded.

CLI JSON uses data-only adapter definitions:

```json
{
  "sampling": { "mode": "scene", "maxFrames": 4 },
  "vision": {
    "policy": "user-only",
    "providers": [
      {
        "adapter": "openai-vision",
        "model": "YOUR_SUPPORTED_MODEL",
        "apiKeyEnv": "OPENAI_API_KEY",
        "structured": true
      }
    ]
  },
  "transcription": { "policy": "disabled" }
}
```

CLI adapter names: `openai-vision`, `openai-transcription`, `ollama`, `whisper.cpp`, `custom`. Complex transforms/plugins require SDK configuration, not executable JSON.

## Results, evidence and search

Version `1.0` results contain:

- `metadata`, ordered `scenes` and actual `frames`.
- `evidence` IDs with video-relative times and source offsets.
- `transcript` with language, segments, available precision and provenance.
- `observations`, `textOnScreen`, `events` and an ordered unified `timeline`.
- Independent capability `status`.
- `coverage` with duration examined, sampled timestamps, unexamined visual intervals and truncation.
- `processing` with request counts, warnings, declared capabilities, failures, provider provenance and optional configured cost estimate.

```js
const matches = vie.search(result, "visible text", {
  type: "ocr",
  start: 0,
  end: 60,
});
const moments = vie.findMoments(result, "red surface");
console.log(matches, moments.status);
```

Search is lexical over available evidence, not hidden embedding/LLM reasoning. No match returns `insufficient-evidence`, not proof of absence.

Descriptions/objects/OCR are provider-reported observations. Classification and accepted multi-frame activities are marked inference. Confidence is absent unless supplied and is not a calibrated accuracy guarantee.

Single stills cannot establish movement. Activities require an explicitly temporal-capable plugin and at least two distinct referenced frame timestamps. Built-in image adapters do not claim action recognition or persistent object identity tracking.

## CLI

```sh
vie --help
vie status
vie inspect video.mp4 --json
vie analyze video.mp4 --json -o analysis.json
vie --config ./vie.json analyze video.mp4
vie --config ./vie.json config
vie models
vie list
vie --model-dir ./private-models install manifest.json
vie --model-dir ./private-models remove model-id --yes
vie status --runtime http://127.0.0.1:11434 --kind ollama
```

Output/snapshot paths must be new files; source videos and existing files are never overwritten. `config` validates without printing keys. Ctrl-C cancels processing.

SDK methods: `analyze`, `getMetadata`, `extractAudio`, `extractFrames`, `getScenes`, `getTranscript`, `getFrame`, `findMoments`, `search`, `status`, `health`, `clearCache`. Public TypeScript declarations describe the exact types.

Runnable scripts in `examples/`: `native.mjs`, `disabled-vision.mjs`, `remote-provider.mjs`, `custom-mapping.mjs`, `local-only.mjs`. Install the package in the consuming project before running them. External examples require real endpoint/model configuration and explicitly send media when run.

## Budgets, progress and cancellation

Defaults: 512 MiB input, 3600 seconds, 30 frames, 100 provider attempts, two retries per operation, 20 total retries and a 300-second runtime budget.

```js
const controller = new AbortController();
const vie = new VIE({
  maxDuration: 120,
  maxRuntimeMs: 60000,
  maxRequests: 12,
  maxRetries: 1,
  retryBudget: 3,
  sampling: { maxFrames: 8 },
  onProgress: (event) =>
    console.error(event.stage, event.completed, event.total),
});
const result = await vie.analyze("./video.mp4", { signal: controller.signal });
// Call controller.abort() to cancel.
```

Progress reports actual stages/counts, not invented percentages. Frame batches and audio chunks keep individual requests bounded. Provider failures preserve successful capabilities; invalid input or required native-processing failures can reject the operation. Caller cancellation throws `CANCELLED`.

`checkpointPath` writes a final JSON snapshot only. It is not a resumable subprocess checkpoint. On reruns, explicitly versioned provider caches can avoid repeated inference.

Queues enforce per-provider concurrency for a VIE instance. Retryable failures include transient network/DNS errors, timeouts, 429 and 500/502/503/504. Authentication and malformed/unsupported requests are not blindly retried, though permitted backups may be attempted. Retry-After is not shortened. Circuit breakers use closed/open/half-open states and allow bounded recovery probes. Inspect `health()` for process-local health.

## Caching and errors

```js
const vie = new VIE({
  cacheDir: "./dedicated-vie-cache",
  cacheNamespace: "tenant-and-authorization-scope",
  vision: {
    providers: [
      openAIVision({
        model: process.env.VISION_MODEL,
        apiKey: process.env.OPENAI_API_KEY,
        cacheIdentity: "my-endpoint-and-mappings-v1",
      }),
    ],
  },
});
await vie.clearCache();
```

Persistent caching requires explicit identities on every provider in the capability chain. Keys incorporate content, model, identity, relevant request/configuration and tenant namespace, never credentials. Revise identities when endpoints, mappings or generation settings change. Native extraction is not currently cached. Cache files may contain personal transcript/description data.

Errors use `VIEError` with codes including INPUT, FORMAT, FFMPEG_MISSING, MEDIA, CONFIG, AUTH, RATE_LIMIT, TIMEOUT, NETWORK, MALFORMED, EXHAUSTED, MODEL_MISSING, INSTALL, CANCELLED, BUDGET and SECURITY. Inspect `processing.failures`, `processing.warnings` and attempt provenance; raw provider bodies, keys and subprocess stderr are not exposed.

Configured per-request pricing can estimate successful requests when all prices use one currency. It excludes unknown failed-request/token charges and is not an invoice.

## Security and limitations

- Public HTTPS destinations are checked at URL resolution and socket connection to prevent DNS rebinding. Private/reserved IPs, URL credentials and redirects are rejected.
- Native subprocesses use argument arrays without a shell. Only local file/pipe protocols and self-contained container demuxers are allowed; playlists are deliberately rejected.
- Temporary directories/files are private where OS permissions support it. Keep FFmpeg patched and run hostile-media workloads with OS-level least privilege.
- Runtime servers, plugins and delivery callbacks are trusted application code, not sandboxed.
- Results/metadata may contain private source data; do not indiscriminately log or publish them.
- Native scene scores can miss gradual/similar cuts or detect flashes. Tune against your own labels.
- Samples do not prove what occurred in gaps. No perfect understanding, calibrated confidence, invisible event detection or real identity tracking is claimed.
- Dense accurate frame decoding can be expensive; use explicit frame/duration/runtime limits.

Troubleshooting: install both binaries for FFMPEG_MISSING; check source/codec integrity for MEDIA; start/load local runtimes for MODEL_MISSING; verify actual credentials/permissions for AUTH; inspect mappings and model JSON support for MALFORMED; inspect budgets/coverage for truncation; configure final public HTTPS or explicit loopback endpoints for SECURITY.

## Development and verification

Only authorized source copies may run the development workflow:

```sh
npm ci
npm run check
npm run format:check
npm run evaluate
npm run smoke:clone
npm pack --dry-run
```

The test suite uses real synthetic MP4/MOV/MKV/WEBM, short/long/low-rate clips, corruption, missing/audio-only streams, stream/Blob/File ingestion, cleanup, source offsets and cancellation. HTTP/model fixtures test adapters, mappings, explicit installation, fallback policies, queues, circuits, budgets, caching and partial evidence without downloading weights or calling paid services.

Native evaluation measures four labeled hard cuts and sample positions: the verified run had precision/recall 1.0 and mean timestamp error 0 seconds for those narrow synthetic cases. This is not a general semantic-accuracy score. A generated `VIE 42` fixture supports OCR character-error scoring when an actual OCR-capable provider is configured.

```sh
# Explicitly authorizes the configured provider requests and possible charges:
npm run evaluate -- --config ./your-provider.json --allow-provider-requests
```

Without a provider, OCR and unsupported semantic-claim rates remain unmeasured/null, not “perfect.”

Verification distinctions:

| Area               | Actual evidence                                                                   |
| ------------------ | --------------------------------------------------------------------------------- |
| Native processing  | Real FFmpeg/FFprobe media tests                                                   |
| OpenAI contracts   | Mocked transport, not paid live accuracy                                          |
| Ollama/whisper.cpp | Real loopback HTTP fixtures, not actual model inference                           |
| Qwen/Nemotron      | Mocked contracts; live routes/schema require verification                         |
| Model lifecycle    | Tiny controlled artifact with size/hash checks, not model weights                 |
| Package            | Installed ESM/CommonJS/CLI/native smoke on Linux Node 20.20 and 24.22             |
| Portability        | Public-registry fresh-cache checkout install and full checks                      |
| Platforms          | Linux verified here; macOS/Windows GitHub checks configured, not claimed executed |

All dependency tarballs in the lockfile must use public npm URLs. After managed dependency updates, `npm run lockfile:portable` checks each pinned version/integrity against public metadata before normalizing only download addresses. `lockfile:check` catches internal mirrors before CI installation. This does not bypass blocked dependency checks.

Requirements are covered by native media tests; adapter/HTTP contract tests; model lifecycle tests; evidence, timestamp, search and policy tests; package inspection and clean-install smoke tests; and an explicitly approved release workflow. Optional execution resume, optical flow, precise tracking and live semantic evaluation are not represented as completed features.

## Releasing to npm

The repository's **Explicit npm release** GitHub Actions workflow uses the repository secret named `NPM_TOKEN`. Never place its value in source or paste it into chat.

This isolated task copy does not publish. After changes are merged, the manual workflow requires `PUBLISH` and the exact package version, uses the `npm-release` environment, validates the owner-approved license, checks npm authentication, runs quality/package checks, and then publishes. Configure required reviewers for that environment in GitHub if review approval is needed; YAML cannot create that policy itself.

Prerelease versions publish under the `alpha` dist-tag, not `latest`. Stable releases additionally require explicit stable-release approval in `release-readiness.json`. npm itself enforces whether the token may publish this package name; adding a secret alone is not proof of that permission.

The restrictive license is included in the package. Public npm distribution makes package code downloadable: a license restricts legal permission but cannot technically stop someone copying it. No claim is made that npm can enforce a source-cloning prohibition.

## License

**Proprietary — owner authorization required.** See [LICENSE](LICENSE).

Cloning, mirroring, copying or redistributing the source requires the owner's explicit prior authorization. An owner-authorized npm distribution permits installation and execution of that distributed package under the LICENSE terms; it does not grant permission to clone the source repository or redistribute the project. This is not an open-source license.

The only project documentation Markdown files are this README and [CHANGELOG.md](CHANGELOG.md). Examples remain executable code. Internal agent instructions are not package documentation and are excluded from the npm package.
