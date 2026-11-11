import { VIE } from "vie-engine";
const vie = new VIE({
  vision: { policy: "disabled" },
  transcription: { policy: "disabled" },
});
const result = await vie.analyze(process.argv[2]);
console.log(
  JSON.stringify(
    { status: result.status, frames: result.frames, coverage: result.coverage },
    null,
    2,
  ),
);
