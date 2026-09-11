import { scenario } from "../scenario.ts";
import { bash, say, think, tool, user } from "../transcript.ts";

const LONG_OUTPUT = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: ok`).join("\n");

export default scenario("chat", {
  description: "A long transcript: thinking, tool cards, a failure, wide output.",
  active: "sbx-chat",
  sessions: [
    {
      id: "sbx-chat",
      name: "api",
      repo: {
        base: {
          "src/server.ts": "export const port = 4111;\n",
          "README.md": "# api\n",
        },
      },
      entries: [
        user("Where is the port configured?"),
        think(
          "The user wants the port. Grep for it rather than guessing.",
          "Let me look.",
        ),
        ...tool("t1", "grep", { pattern: "port", path: "src" }, "src/server.ts:1: export const port = 4111;"),
        say("It is `src/server.ts`, line 1."),
        user("Run the tests and show me everything."),
        ...tool("t2", "bash", { command: "pnpm test" }, LONG_OUTPUT),
        ...tool(
          "t3",
          "read",
          { path: "/etc/shadow" },
          "EACCES: permission denied, open '/etc/shadow'",
          true,
        ),
        say(
          "Tests pass. One read failed:\n\n```\nEACCES: permission denied\n```\n\nA very long single word follows to test wrapping: " +
            "supercalifragilisticexpialidocious".repeat(3),
        ),
        bash("git status --short", " M src/server.ts\n?? notes.md", 0),
        user("Thanks"),
      ],
    },
    {
      id: "sbx-chat-2",
      name: "docs",
      entries: [user("Fix the typo in the readme"), say("Done.")],
    },
  ],
});
