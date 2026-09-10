// The leftover a Windows upgrade cannot clean up after itself, and where it goes.
//
// The replace renames the running `mdbrain.exe` out of the way before moving the
// new one in, so an `<execPath>.old` is left behind — and it cannot be deleted
// while the process that was running from it is alive. So the deletion is
// somebody else's, later.
//
// **Every invocation that could have made one attempts it and ignores failure**,
// and the ignoring is the point rather than a shortcut: failure means an old
// process is still running, which is exactly when to leave the file alone. It reaches neither the person
// nor the exit code, because a person who has just upgraded has nothing to do
// about it and a script reading a non-zero exit would be reading a success.
//
// **It lives in the binary rather than only in the installer**, because
// `upgrade` produces the same leftover as the install script does — an
// installer-only sweep would leave one behind for every upgrade that did not
// come through the script, which is every upgrade this command performs.

import { rm } from "node:fs/promises";
import { isCompiledExecPath, oldPathFor, type UpgradePlatform } from "./plan.ts";

/**
 * Try to remove the displaced binary beside this one.
 *
 * **Only where this program could have made one**, which is the guard rather
 * than a narrowing: the displacing rename is Windows's alone, and `execPath` is
 * the interpreter rather than an install when the program is run from source.
 * Without it, every `mdbrain` on POSIX would try to delete an `<execPath>.old`
 * that only a person could have created, and `node src/main.ts` would aim that
 * at the machine's own `node.old`.
 *
 * @param execPath the running binary's own path
 * @param platform the platform this is running on
 * @param remove injected so a test can watch the attempt without a filesystem
 * @returns nothing, ever, and never throws
 */
export async function sweepLeftover(
  execPath: string,
  platform: UpgradePlatform,
  remove: (path: string) => Promise<void> = (path) => rm(path, { force: false }),
): Promise<void> {
  if (platform !== "win32" || !isCompiledExecPath(execPath)) return;
  try {
    await remove(oldPathFor(execPath));
  } catch {
    // Deliberately nothing. See the header: a failure here is the expected
    // outcome while the old process is alive, and reporting it would tell
    // somebody about a file they neither made nor can do anything about.
  }
}
