import type { Scenario } from "../scenario.ts";
import chat from "./chat.ts";
import empty from "./empty.ts";
import gitDirty from "./git-dirty.ts";
import manySessions from "./many-sessions.ts";

export const scenarios: Scenario[] = [empty, chat, gitDirty, manySessions];

export function findScenario(name: string): Scenario {
  const found = scenarios.find((s) => s.name === name);
  if (found) return found;
  throw new Error(
    `unknown scenario "${name}". Known: ${scenarios.map((s) => s.name).join(", ")}`,
  );
}
