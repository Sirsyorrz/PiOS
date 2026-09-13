import { scenario } from "../scenario.ts";
import { say, user } from "../transcript.ts";

/**
 * A directory git knows nothing about, plus a session named like the id it was
 * given. Both are states the header has to survive: the chip still reads
 * "git" and opens on an offer to initialize, and the title falls back to the
 * directory rather than showing a random string.
 */
export default scenario("git-none", {
  description: "A session in a plain directory, with an id-shaped name.",
  active: "sbx-plain",
  sessions: [
    {
      id: "sbx-plain",
      name: "8f14e45fceea167a5a36dedd4bea2543",
      repo: false,
      entries: [
        user("Is this a repository?"),
        say("There is no `.git` here yet."),
      ],
    },
  ],
});
