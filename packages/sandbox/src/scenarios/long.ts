import { crc32, deflateSync } from "node:zlib";
import { scenario } from "../scenario.ts";
import type { EntrySeed } from "../transcript.ts";
import { say, think, tool, toolCall, user } from "../transcript.ts";

const ANSWER = [
  "Here is what changed:",
  "",
  "- `src/server.ts` reads the **port** from the environment",
  "- the tests cover the _default_ and an override",
  "",
  "```ts",
  "export const port = Number(process.env.PORT ?? 4111);",
  "```",
  "",
  "| file | lines |",
  "| --- | ---: |",
  "| src/server.ts | 3 |",
].join("\n");

/**
 * A noisy PNG, so it does not compress: a contact sheet from a real session
 * is a megabyte of base64, and that weight is what this scenario is about.
 */
function noisyPng(width: number, height: number, seed: number): string {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let state = seed * 2654435761;
  for (let i = 0; i < raw.length; i++) {
    if (i % (width * 3 + 1) === 0) continue;
    state = (state * 1103515245 + 12345) >>> 0;
    raw[i] = state >>> 24;
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

function screenshot(id: string, path: string, seed: number): EntrySeed[] {
  return [
    toolCall(id, "read", { path }),
    {
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: `Read image file [image/png]` },
          { type: "image", mimeType: "image/png", data: noisyPng(480, 360, seed) },
        ],
      },
    },
  ];
}

export default scenario("long", {
  description: "A long history with heavy tool images, for load, scroll and render cost.",
  active: "sbx-long",
  sessions: [
    {
      id: "sbx-long",
      name: "long",
      entries: Array.from({ length: 60 }, (_, i) => [
        user(`Step ${i + 1}: keep going`),
        think("Check the file first, then change it.", "Reading."),
        ...tool(`t${i}`, "bash", { command: `cat src/file${i}.ts` }, `line a\nline b\nline c`),
        ...(i % 3 === 0 ? screenshot(`s${i}`, `/tmp/shot${i}.png`, i + 1) : []),
        say(ANSWER),
      ]).flat(),
    },
  ],
});
