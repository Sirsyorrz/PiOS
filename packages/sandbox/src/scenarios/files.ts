import { scenario } from "../scenario.ts";
import { say, user } from "../transcript.ts";

/** Files the editor must refuse, built here so the sizes are honest. */
const HUGE = `${"y".repeat(1024 * 1024 + 10)}\n`;
const BINARY = `PNG\u0000\u0000IHDR\u0000binary bytes\n`;
const MINIFIED = `export const x=${"1+".repeat(30_000)}1;\n`;

export default scenario("files", {
  description: "A project to browse and edit: nested sources, CRLF, and files the editor refuses.",
  active: "sbx-files",
  sessions: [
    {
      id: "sbx-files",
      name: "editor",
      repo: {
        base: {
          "README.md": "# sandbox\n\nOpen a file from the header.\n",
          "src/index.ts": "export function main(): number {\n  return 1;\n}\n",
          "src/deep/nested/util.ts": "export const noop = () => {};\n",
          "config.yaml": "name: sandbox\nitems:\n  - one\n  - two\n",
          "notes.txt": "line one\r\nline two\r\nno trailing newline",
          "big.txt": HUGE,
          "image.bin": BINARY,
          "bundle.min.js": MINIFIED,
        },
      },
      entries: [
        user("Where does main live?"),
        say("`src/index.ts`. It returns `1`."),
      ],
    },
  ],
});
