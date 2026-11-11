# VIE Engine on Replit

This repository is a Node.js TypeScript SDK and CLI, not a web application.
It does not need an HTTP server or a preview port.

## Setup and checks

- Node.js 20.3+ and FFmpeg/FFprobe must be available on PATH.
- Automatic post-merge setup runs `bash scripts/post-merge.sh` to restore
  locked dependencies without lifecycle scripts and build the package.
- Run `npm run check && npm run format:check` for quality checks.
- Run `npm run evaluate` for the synthetic native-media evaluation.
- Run `node dist/cli.js --help` for CLI usage.
- The configured `quality` and `native-evaluation` workflows run those checks.

No API credentials or AI model downloads are required for native checks.
Provider integration and live model verification are separate from these checks.
Never publish to npm or download model weights without explicit authorization.
