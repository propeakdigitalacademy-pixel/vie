import { VIE, ollamaVision, whisperCpp } from "vie-engine";
if (!process.env.VIE_LOCAL_VISION_MODEL)
  throw new Error(
    "Set VIE_LOCAL_VISION_MODEL to an already installed vision model reported by Ollama /api/tags.",
  );
const vie = new VIE({
  vision: {
    policy: "local-only",
    providers: [
      ollamaVision({
        model: process.env.VIE_LOCAL_VISION_MODEL,
        structured: true,
      }),
    ],
  },
  transcription: { policy: "local-only", providers: [whisperCpp()] },
  maxRetries: 0,
  sampling: { maxFrames: 3 },
});
const result = await vie.analyze(process.argv[2]);
console.log(JSON.stringify(result, null, 2));
