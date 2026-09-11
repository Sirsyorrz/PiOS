import { scenario } from "../scenario.ts";
import { say, user } from "../transcript.ts";

export default scenario("git-conflict", {
  description: "A repo stopped mid-merge with a conflicted file.",
  active: "sbx-conflict",
  sessions: [
    {
      id: "sbx-conflict",
      name: "merge/rescue",
      repo: {
        branch: "main",
        base: {
          "src/app.ts": "export const version = 1;\n",
          "README.md": "# app\n",
        },
        conflict: { branch: "feature/rewrite", path: "src/app.ts" },
      },
      entries: [
        user("Merge feature/rewrite"),
        say("The merge stopped: `src/app.ts` conflicts. Resolve it, stage it, then continue."),
      ],
    },
  ],
});
