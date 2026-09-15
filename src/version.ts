// What this build is: its version, the artifact it was compiled as, and how it
// arrived on the machine.
//
// Its own module rather than constants in `src/main.ts`, because `upgrade` reads
// all three and `main.ts` imports `upgrade` — so leaving them there would be a
// cycle. Nothing here has a dependency of any kind, which is also what lets the
// release build rewrite the `TARGET` line with a `sed` and be confident it has
// not touched anything else.

/** The version `--version` prints; kept in step with `package.json`. */
export const VERSION = "0.3.1";

/**
 * The release artifact this binary was compiled as.
 *
 * **Baked in rather than detected**, which is the one place `upgrade` is in a
 * strictly better position than the install scripts: a compiled `mdbrain`
 * already *is* a particular target, where a script has to guess from `uname` and
 * carries musl detection to prove it. Detection here would have to make that
 * same guess and would have exactly one way to be silently wrong — a musl
 * machine handed the glibc build, which downloads, verifies, replaces and then
 * does not run.
 *
 * The value below is the development default. **The release build rewrites this
 * line per target**, and it is the only line anything rewrites: `CHANNEL` is a
 * constant a future package-manager formula would set for itself, so it sits
 * here for the same reason rather than for the same mechanism.
 */
export const TARGET = "linux-x64";

/**
 * How this binary arrived, which is what `upgrade` may and may not replace.
 *
 * **A refusal rather than a label.** A binary a package manager placed is one
 * that manager believes it owns, and the failure of overwriting it is not the
 * overwrite: it is the next `brew upgrade` quietly putting its own version back,
 * so the person reads a version that is not the one on disk.
 *
 * It ships now because it is one line now and a migration later — a binary
 * already in the field has no channel, so retrofitting means either guessing
 * from the install path or reading absence as direct-install, which is the guess
 * this exists to avoid. Nothing about Homebrew or Scoop needs to exist first.
 */
export const CHANNEL: import("./upgrade/plan.ts").Channel = "direct";
