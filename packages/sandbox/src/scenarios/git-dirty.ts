import { scenario } from "../scenario.ts";
import { say, user } from "../transcript.ts";

export default scenario("git-dirty", {
  description: "A repo with staged, unstaged, untracked and deleted files, branches, stashes and a diverged origin.",
  active: "sbx-git",
  sessions: [
    {
      id: "sbx-git",
      name: "feature/git-view",
      repo: {
        branch: "feature/git-view",
        base: {
          "src/index.ts": "export function main() {\n  return 1;\n}\n",
          "src/util.ts": "export const noop = () => {};\n",
          "docs/guide.md": "# guide\n\nold line\n",
          "legacy.txt": "delete me\n",
        },
        commits: [
          { message: "add changelog", files: { "CHANGELOG.md": "# changelog\n" } },
          { message: "tighten util", files: { "src/util.ts": "export const noop = (): void => {};\n" } },
        ],
        branches: ["main", "fix/parser", "chore/deps"],
        remote: { ahead: 2, behind: 1 },
        stashes: ["spike: alternate parser"],
        staged: { "src/index.ts": "export function main(): number {\n  return 2;\n}\n" },
        modified: { "docs/guide.md": "# guide\n\nnew line\nanother new line\n" },
        untracked: { "notes.md": "scratch\n", "tmp/out.log": "noise\n" },
        deleted: ["legacy.txt"],
      },
      entries: [
        user("Stage the index change and write a commit message"),
        say("Staged `src/index.ts`. Suggested message: `feat: return 2 from main`."),
      ],
    },
  ],
});
