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
  run: () => void;
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
): NativeCommand | undefined {
  const match = /^\/(\S+)$/.exec(text.trim());
  if (!match) return undefined;
  return commands.find((command) => command.name === match[1]);
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
