import type { RefObject } from "react";
import { useClient } from "../client-provider.tsx";

/**
 * Switches the reasoning effort for one session, from the input dock.
 *
 * The levels come from the session summary rather than from a constant here:
 * which ones exist depends on the loaded model, and pi clamps the active one
 * when the model changes.
 */
export function ThinkingPicker({ sessionId, current, levels, selectRef }: {
  sessionId: string;
  current?: string;
  levels: string[];
  /** Lets `/think` open the same control the dock shows. */
  selectRef?: RefObject<HTMLSelectElement | null>;
}) {
  const client = useClient();

  // A model without reasoning reports `["off"]`, which is a control with
  // nothing to choose: hide it instead of showing a dead select.
  if (levels.length < 2) return null;

  return (
    <select
      ref={selectRef}
      className="ghost thinking-select"
      aria-label="thinking level"
      value={current && levels.includes(current) ? current : ""}
      onChange={(event) => client.setThinkingLevel(sessionId, event.target.value)}
    >
      {current && levels.includes(current) ? null : <option value="">Think</option>}
      {levels.map((level) => (
        <option key={level} value={level}>
          {label(level)}
        </option>
      ))}
    </select>
  );
}

/**
 * pi's levels are a closed set; a model only varies in which of them it
 * offers. Anything outside the set is a level added by a newer pi, so it is
 * shown raw rather than hidden behind a guess.
 */
const LABELS: Record<string, string> = {
  off: "No Thinking",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

function label(level: string): string {
  return LABELS[level] ?? level;
}
