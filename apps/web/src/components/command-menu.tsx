import type { CommandOption } from "@pios/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../client-provider.tsx";
import type { NativeCommand } from "./native-commands.ts";
import { ListRowButton } from "./ui.tsx";

/** The prefix being completed, or null when the text is not a bare `/name`. */
export function slashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1]! : null;
}

export interface MenuEntry {
  name: string;
  /** Shown instead of `/name`, for entries that are not slash commands. */
  label?: string;
  description?: string;
  /** Where it comes from: an app screen, or one of pi's own sources. */
  badge: string;
  /** Set for a command this client runs itself instead of prompting with. */
  run?: (args: string) => void;
}

/**
 * Commands matching what is typed: this client's own, then pi's.
 *
 * pi's list is asked for per session and never persisted: extensions, prompt
 * templates and skills can be reloaded under the daemon, so a cached answer
 * would offer commands that no longer exist.
 */
export function useSlashCommands(
  sessionId: string,
  query: string | null,
  native: NativeCommand[],
): MenuEntry[] {
  const client = useClient();
  const [commands, setCommands] = useState<CommandOption[]>(() => client.getCommands(sessionId));

  useEffect(
    () =>
      client.onCommands((changed, next) => {
        if (changed === sessionId) setCommands(next);
      }),
    [client, sessionId],
  );

  // Asked on the first slash rather than on attach: most turns never open the
  // menu, and the answer is only worth having when it is about to be shown.
  const open = query !== null;
  useEffect(() => {
    if (!open) return;
    setCommands(client.getCommands(sessionId));
    client.listCommands(sessionId);
  }, [client, sessionId, open]);

  if (query === null) return [];
  const needle = query.toLowerCase();
  const entries: MenuEntry[] = [
    ...native.map((command) => ({
      name: command.name,
      description: command.description,
      badge: "app",
      run: command.run,
    })),
    ...commands.map((command) => ({
      name: command.name,
      description: command.description,
      badge: command.source ?? "pi",
    })),
  ];
  return entries
    .filter((entry) => entry.name.toLowerCase().includes(needle))
    .sort((a, b) => rank(a, needle) - rank(b, needle));
}

/** Prefix matches first: typing `re` means `/resume` before `/pre-commit`. */
function rank(entry: MenuEntry, needle: string): number {
  return entry.name.toLowerCase().startsWith(needle) ? 0 : 1;
}

/** Completion list above the composer. Completing one never sends. */
export function CommandMenu({ entries, active, onPick }: {
  entries: MenuEntry[];
  /** Index the keyboard is on; the pointer can still pick any row. */
  active: number;
  onPick: (entry: MenuEntry) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="command-menu scroll-y" role="listbox">
      {entries.map((entry, index) => (
        <ListRowButton
          key={`${entry.badge}/${entry.name}`}
          className={index === active ? "active" : undefined}
          trailing={<span className="muted">{entry.badge}</span>}
          // Picking must not blur the field: a blur closes the keyboard and
          // drops the caret, and the completion lands back in the text.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(entry)}
        >
          <span className="line">{entry.label ?? `/${entry.name}`}</span>
          {entry.description ? <span className="line muted">{entry.description}</span> : null}
        </ListRowButton>
      ))}
    </div>
  );
}
