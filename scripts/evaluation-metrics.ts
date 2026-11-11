/** Character error rate with explicit labels; not a general semantic accuracy metric. */
export function characterErrorRate(expected: string, actual: string): number {
  const a = expected.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const b = actual.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  let prior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1]! + 1,
        prior[j]! + 1,
        prior[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prior = row;
  }
  return prior[b.length]! / Math.max(1, a.length);
}
/** Portable generated text image: fixed 5x7 glyphs, no fonts, assets or downloads. */
export function labeledTextPPM(): Buffer {
  const glyphs: Record<string, string[]> = {
    V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
    I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
    "2": ["11111", "00001", "00001", "11111", "10000", "10000", "11111"],
    " ": Array(7).fill("00000"),
  };
  const width = 320,
    height = 120,
    scale = 7;
  const pixels = Buffer.alloc(width * height * 3);
  for (const [i, char] of [..."VIE 42"].entries())
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 5; x++) {
        if (glyphs[char]![y]![x] !== "1") continue;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const index =
              ((y * scale + 30 + dy) * width +
                (i * 6 * scale + x * scale + 30 + dx)) *
              3;
            pixels.fill(255, index, index + 3);
          }
      }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}
