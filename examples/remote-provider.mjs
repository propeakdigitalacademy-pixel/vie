import { VIE, openAITranscription, openAIVision } from "vie-engine";
// Running this example is explicit authorization to send extracted media to OpenAI.
if (
  !process.env.OPENAI_API_KEY ||
  !process.env.VIE_VISION_MODEL ||
  !process.env.VIE_SPEECH_MODEL
)
  throw new Error(
    "Set OPENAI_API_KEY, VIE_VISION_MODEL and VIE_SPEECH_MODEL after reviewing provider pricing.",
  );
const vie = new VIE({
  maxRequests: 10,
  maxRetries: 1,
  retryBudget: 2,
  transcription: {
    providers: [
      openAITranscription({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.VIE_SPEECH_MODEL,
      }),
    ],
  },
  vision: {
    providers: [
      openAIVision({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.VIE_VISION_MODEL,
      }),
    ],
  },
  sampling: { maxFrames: 4, mode: "scene" },
});
const result = await vie.analyze(process.argv[2]);
console.log(JSON.stringify(result, null, 2));
