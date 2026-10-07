import { scenario } from "../scenario.ts";
import { cut, fail, say, user } from "../transcript.ts";

const RATE_LIMIT = '429: {"message":"Rate limit reached for requests","type":"rate_limit"}';
const OVERLOADED = '529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

export default scenario("errors", {
  description:
    "Provider failures: retried then given up, recovered, stopped, cut off. Send RATE_LIMIT for a live retry.",
  active: "sbx-errors",
  sessions: [
    {
      id: "sbx-errors",
      name: "api",
      entries: [
        user("Summarise the changelog"),
        fail(RATE_LIMIT),
        fail(RATE_LIMIT),
        fail(RATE_LIMIT),
        user("Try again"),
        fail(OVERLOADED),
        say("The changelog adds retry banners and fixes the pairing flow."),
        user("Write the full release notes"),
        cut("## Release notes\n\nThis release", "length"),
        user("Explain the build"),
        cut("The build runs in three", "aborted"),
        user("Is the provider up?"),
        fail("fetch failed"),
      ],
    },
  ],
});
