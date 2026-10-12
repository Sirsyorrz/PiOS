import { scenario } from "../scenario.ts";

export default scenario("empty", {
  description: "One clean repo, no transcript, not yet trusted. The first-run view.",
  sessions: [{ id: "sbx-empty", name: "scratch", trusted: false }],
});
