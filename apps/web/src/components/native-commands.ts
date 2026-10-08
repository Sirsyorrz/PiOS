/**
 * Commands pi handles in its terminal UI and never through a prompt.
 *
 * `get_commands` deliberately omits them: sending `/settings` as a prompt just
 * reaches the model. They exist here as local actions so the one place a
 * command is typed answers for every command the user knows.
 */
export interface NativeCommand {
  /** Without the leading slash, matching pi's own name for it. */
  name: string;
  description: string;
  /** What followed the name on the line; empty when it was picked from the menu. */
  run: (args: string) => void;
}

/**
 * The command a finished line invokes, or undefined when it is a prompt.
 *
 * One rule for both paths into a command: completing it in the menu and
 * sending the typed line must not disagree about what `/settings` means.
 */
export function nativeCommandFor(
  text: string,
  commands: NativeCommand[],
): { command: NativeCommand; args: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const command = commands.find((candidate) => candidate.name === match[1]);
  return command ? { command, args: (match[2] ?? "").trim() } : undefined;
}

/** Opens a native select from a command, since there is nothing to tap. */
export function openSelect(select: HTMLSelectElement | null): void {
  if (!select) return;
  select.focus();
  // Chromium only; elsewhere focus is as far as a script may open a select.
  const picker = (select as { showPicker?: () => void }).showPicker;
  try {
    picker?.call(select);
  } catch {
    // Some browsers require a user gesture they do not consider this to be.
  }
}
