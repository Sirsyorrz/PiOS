import { scenario } from "../scenario.ts";
import { say, user } from "../transcript.ts";

const NAMES = [
  "api",
  "web",
  "infra",
  "a-session-with-a-very-long-name-that-must-truncate",
  "docs",
  "spike",
  "hotfix",
  "release",
];

export default scenario("many-sessions", {
  description: "Eight sessions, for list layout, truncation and unread marks.",
  sessions: NAMES.map((name, i) => ({
    id: `sbx-many-${i + 1}`,
    name,
    entries: [user(`work on ${name}`), say(`Working on ${name}.`)],
  })),
});
