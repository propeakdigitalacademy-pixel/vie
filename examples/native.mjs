import { VIE } from "vie-engine";
const input = process.argv[2];
if (!input) throw new Error("Usage: node examples/native.mjs video.mp4");
const vie = new VIE({
  sampling: { mode: "scene", maxFrames: 12 },
  onProgress: (event) => console.error(event.stage),
});
const result = await vie.analyze(input);
console.log(
  JSON.stringify(
    {
      metadata: result.metadata,
      scenes: result.scenes,
      coverage: result.coverage,
    },
    null,
    2,
  ),
);
