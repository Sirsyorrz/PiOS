import type { Scenario } from "../scenario.ts";
import chat from "./chat.ts";
import cold from "./cold.ts";
import empty from "./empty.ts";
import errors from "./errors.ts";
import files from "./files.ts";
import gitConflict from "./git-conflict.ts";
import gitDirty from "./git-dirty.ts";
import gitNone from "./git-none.ts";
import manySessions from "./many-sessions.ts";

export const scenarios: Scenario[] = [
  empty,
  chat,
  cold,
  errors,
  files,
  gitDirty,
  gitNone,
  gitConflict,
  manySessions,
];

export function findScenario(name: string): Scenario {
  const found = scenarios.find((s) => s.name === name);
  if (found) return found;
  throw new Error(
    `unknown scenario "${name}". Known: ${scenarios.map((s) => s.name).join(", ")}`,
  );
}
