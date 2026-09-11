/**
 * The shell both stubs pretend to have.
 *
 * Shared so the two hosts cannot pass the contract suite against different
 * behaviour. Nothing is executed: the output is derived from the command, and
 * `SLOW_BASH` is the fixture that stays running long enough to be cancelled.
 */
export interface FakeBashResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runFakeBash(
  command: string,
  onChunk: (delta: string) => void,
  cancelled: () => boolean,
): Promise<FakeBashResult> {
  const slow = command.includes("SLOW_BASH");
  const chunks = slow
    ? ["tick\n", "tick\n", "tick\n", "tick\n", "tick\n"]
    : [`ran: ${command}\n`, "done\n"];

  let output = "";
  for (const chunk of chunks) {
    if (slow) await sleep(20);
    if (cancelled()) return { output, exitCode: undefined, cancelled: true, truncated: false };
    output += chunk;
    onChunk(chunk);
  }
  return {
    output,
    exitCode: command.includes("FAIL") ? 1 : 0,
    cancelled: false,
    truncated: false,
  };
}
