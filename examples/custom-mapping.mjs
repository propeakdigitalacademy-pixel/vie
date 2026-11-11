import { VIE, customHTTP } from "vie-engine";
if (!process.env.VIE_CUSTOM_ENDPOINT)
  throw new Error("Set VIE_CUSTOM_ENDPOINT to your HTTPS service.");
const provider = customHTTP({
  id: "my-vision",
  model: "developer-service",
  capability: "vision",
  endpoint: process.env.VIE_CUSTOM_ENDPOINT,
  bearer: process.env.VIE_CUSTOM_KEY,
  capabilities: { images: true, ocr: true, objects: true },
  media: "base64",
  requestMapping: { image: "input.image_b64", prompt: "input.question" },
  responseMapping: {
    description: "result.caption",
    objects: "result.objects",
    text: "result.ocr",
  },
});
const result = await new VIE({
  vision: { providers: [provider] },
  sampling: { maxFrames: 3 },
}).analyze(process.argv[2]);
console.log(JSON.stringify(result, null, 2));
