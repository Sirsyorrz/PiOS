import type { CommandOption } from "@pios/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../client-provider.tsx";
import { ListRowButton } from "./ui.tsx";

/** The prefix being completed, or null when the text is not a bare `/name`. */
export function slashQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1]! : null;
}

/**
 * Slash commands matching what is typed.
 *
 * The list is asked for per session and never persisted: extensions, prompt
 * templates and skills can be reloaded under the daemon, so a cached answer
 * would offer commands that no longer exist.
 */
export function useSlashCommands(sessionId: string, query: string | null): CommandOption[] {
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
  return commands
    .filter((command) => command.name.toLowerCase().includes(needle))
    .sort((a, b) => rank(a, needle) - rank(b, needle));
}

/** Prefix matches first: typing `re` means `/review` before `/pre-commit`. */
function rank(command: CommandOption, needle: string): number {
  return command.name.toLowerCase().startsWith(needle) ? 0 : 1;
}

/** Completion list above the composer. Picking one never sends. */
export function CommandMenu({ commands, active, onPick }: {
  commands: CommandOption[];
  /** Index the keyboard is on; the pointer can still pick any row. */
  active: number;
  onPick: (command: CommandOption) => void;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="command-menu scroll-y" role="listbox">
      {commands.map((command, index) => (
        <ListRowButton
          key={command.name}
          className={index === active ? "active" : undefined}
          trailing={command.source ? <span className="muted">{command.source}</span> : undefined}
          onClick={() => onPick(command)}
        >
          <span className="line">/{command.name}</span>
          {command.description ? (
            <span className="line muted">{command.description}</span>
          ) : null}
        </ListRowButton>
      ))}
    </div>
  );
}
