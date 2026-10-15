import { createContext, useContext } from "react";
import type { StreamingBehavior } from "@pios/protocol";
import { browserStorage } from "./storage.ts";

const KEY = "pios.settings.v1";

/** How directory entries are ordered in the picker. */
export type DirectorySort = "recent" | "alphabetical";

export interface Settings {
  /** Reasoning blocks start expanded in the transcript. */
  showThinking: boolean;
  /** Finished tool cards start expanded. A running one always is. */
  expandTools: boolean;
  /** Token, cost and context accounting under the transcript. */
  showSessionStats: boolean;
  /** What a prompt typed mid-turn does: steer now, or queue as a follow-up. */
  steeringMode: StreamingBehavior;
  directorySort: DirectorySort;
  /** Pixels; also decides how many columns the shell gets. */
  terminalFontSize: number;
  editorFontSize: number;
}

export const FONT_SIZES = [6, 8, 10, 12, 14, 16, 18] as const;

const DEFAULT_SETTINGS: Settings = {
  showThinking: true,
  expandTools: false,
  showSessionStats: false,
  steeringMode: "steer",
  directorySort: "recent",
  terminalFontSize: 12,
  editorFontSize: 12,
};

/**
 * Unknown and malformed fields fall back to the default one by one, so a
 * record written by an older or newer build still yields a usable object.
 */
export function loadSettings(): Settings {
  const raw = browserStorage.get(KEY);
  if (!raw) return DEFAULT_SETTINGS;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (typeof stored !== "object" || stored === null) return DEFAULT_SETTINGS;
  const record = stored as Record<string, unknown>;
  return {
    showThinking: bool(record.showThinking, DEFAULT_SETTINGS.showThinking),
    expandTools: bool(record.expandTools, DEFAULT_SETTINGS.expandTools),
    showSessionStats: bool(record.showSessionStats, DEFAULT_SETTINGS.showSessionStats),
    steeringMode:
      record.steeringMode === "steer" || record.steeringMode === "followUp"
        ? record.steeringMode
        : DEFAULT_SETTINGS.steeringMode,
    directorySort:
      record.directorySort === "recent" || record.directorySort === "alphabetical"
        ? record.directorySort
        : DEFAULT_SETTINGS.directorySort,
    terminalFontSize: fontSize(record.terminalFontSize, DEFAULT_SETTINGS.terminalFontSize),
    editorFontSize: fontSize(record.editorFontSize, DEFAULT_SETTINGS.editorFontSize),
  };
}

export function saveSettings(settings: Settings): void {
  browserStorage.set(KEY, JSON.stringify(settings));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function fontSize(value: unknown, fallback: number): number {
  return (FONT_SIZES as readonly unknown[]).includes(value) ? (value as number) : fallback;
}

const SettingsContext = createContext<Settings>(DEFAULT_SETTINGS);

export const SettingsProvider = SettingsContext.Provider;

/** Read-only view for the components that only obey the preferences. */
export function useSettings(): Settings {
  return useContext(SettingsContext);
}
