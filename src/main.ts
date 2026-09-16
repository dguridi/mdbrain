// The entry point: the command list, and handing an invocation to it.
//
// The list is the only place a command is registered, and both the dispatcher
// and `--help` are derived from it — so an undocumented subcommand is an
// unreachable one, and there is no second place to remember to update.

import { pathToFileURL } from "node:url";
import { as } from "./commands/as.ts";
import { dispatch, type CommandSpec } from "./cli.ts";
import { configure } from "./commands/configure.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { run as runCommand } from "./commands/run.ts";
import { upgrade } from "./commands/upgrade.ts";
import { whoami } from "./commands/whoami.ts";
import { sweepLeftover } from "./upgrade/sweep.ts";
import { VERSION } from "./version.ts";

// Re-exported so the many callers that already ask this module for the version
// keep working; what it *is* lives in `version.ts`, beside the two other
// build-time constants, because `upgrade` reads all three and this module
// imports `upgrade`.
export { VERSION };

/** Every command this binary has. */
export const COMMANDS: CommandSpec[] = [login, whoami, logout, configure, runCommand, as, upgrade];

/**
 * Run one invocation.
 *
 * Exported so a test can drive it without spawning a process, and separate from
 * the bottom of this file so importing the command list costs nothing.
 */
export function run(argv: string[]): Promise<number> {
  // Best-effort, unawaited and unreported: a Windows upgrade leaves a displaced
  // binary that cannot be deleted while the process running from it is alive, so
  // every invocation has a go and every failure is the expected one. It is here
  // rather than in `upgrade` because the file outlives the command that made it,
  // and in the binary rather than only in the installer because `upgrade` makes
  // the same leftover the installer does.
  void sweepLeftover(process.execPath, process.platform);
  return dispatch(argv, COMMANDS, VERSION, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}

// Only when this file is what was started, so importing it from a test does not
// execute a command.
//
// `import.meta.main` first, because it is the only one of the two that a
// compiled binary can answer: `bun build --compile` puts this module inside a
// virtual root, so its URL is never the executable's path and a URL comparison
// alone would decide the program was imported and run nothing at all. The URL
// comparison is the fallback for a runtime that does not define it, and it
// compares URLs rather than paths because a Windows path and its file URL are
// different strings for the same file.
const startedDirectly =
  (import.meta as { main?: boolean }).main ??
  (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href);

if (startedDirectly) {
  // `process.exitCode` and let the loop drain — **never `process.exit()`**, which
  // is the obvious thing and is wrong here. Calling it after a `fetch` races
  // undici's socket teardown and aborts the process on Windows with
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`. The work is already
  // done and reported by then, so it looks like a cosmetic crash — except the
  // abort replaces the exit code with 127, so anything scripting this reads a
  // successful command as a failure.
  //
  // The cost of draining instead is that a leaked handle would hang the command
  // rather than being papered over. That is the right trade: every handle here is
  // closed on purpose — the listener in `login`'s `finally`, its timeout
  // unreferenced — and a hang is a bug worth seeing.
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      console.error((cause as Error).message);
      process.exitCode = 1;
    },
  );
}
