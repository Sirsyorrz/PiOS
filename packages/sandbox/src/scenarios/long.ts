import { scenario } from "../scenario.ts";
import { say, think, tool, user } from "../transcript.ts";

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

export default scenario("long", {
  description: "A long history, for scroll and render cost while a turn streams.",
  active: "sbx-long",
  sessions: [
    {
      id: "sbx-long",
      name: "long",
      entries: Array.from({ length: 60 }, (_, i) => [
        user(`Step ${i + 1}: keep going`),
        think("Check the file first, then change it.", "Reading."),
        ...tool(`t${i}`, "bash", { command: `cat src/file${i}.ts` }, `line a\nline b\nline c`),
        say(ANSWER),
      ]).flat(),
    },
  ],
});
