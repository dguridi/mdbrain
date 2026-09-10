// What an upgrade decides, with no network, no disk and no process in it.
//
// `upgrade` is a command whose every interesting judgement is made before
// anything is touched: whether there is anything to do, whether this binary is
// one this command may replace, which artifact belongs to it, whether the bytes
// that arrived are the bytes that were published, and — the one that differs by
// platform — in what order the files are moved. All of that lives here so it can
// be checked without a release, a download or a running binary.
//
// **The platform steps are a value rather than a branch.** A plan that says
// *rename the running exe out of the way, then rename the staged file in* can be
// asserted as two steps in that order; the same rule written as an `if` inside
// the executor can only be checked by actually upgrading something on Windows.
// The whole reason it is written per platform rather than as one shape is that
// reading *one shape covers all three* as *identical code* gets Windows wrong,
// and it gets it wrong at the moment somebody is upgrading rather than at
// compile time.

/** The platforms the replace is written for. `node:process`'s own vocabulary. */
export type UpgradePlatform = NodeJS.Platform;

/**
 * How this binary arrived, which decides whether `upgrade` may replace it.
 *
 * A refusal rather than a label: a binary a package manager placed is one that
 * manager believes it owns, and the failure of overwriting it is not the
 * overwrite — it is the next `brew upgrade` quietly putting its own version
 * back, so the person reads a version that is not the one on disk.
 */
export type Channel = "direct" | "homebrew" | "scoop";

/** What to tell somebody whose binary this command may not replace. */
const PACKAGER_COMMAND: Record<Exclude<Channel, "direct">, string> = {
  homebrew: "brew upgrade mdbrain",
  scoop: "scoop update mdbrain",
};

/**
 * Why `upgrade` may not replace this binary, or null when it may.
 *
 * @param channel the build-time constant recording how this binary arrived
 * @returns a sentence naming the command that owns this install, or null
 */
export function channelRefusal(channel: Channel): string | null {
  if (channel === "direct") return null;
  return `This mdbrain was installed with ${channel}, which owns the file — run \`${PACKAGER_COMMAND[channel]}\` instead. Replacing it here would be undone by that command's next run, and until then you would be reading a version that is not the one on disk.`;
}

/**
 * The release tag as a version, or null when the text is not one.
 *
 * The tag arrives as the last segment of a `Location` header, because the lookup
 * reads the `releases/latest` redirect rather than the API — so this takes a URL
 * and not a JSON field, and a redirect that has been changed into something else
 * yields null rather than a plausible-looking wrong answer.
 *
 * @param location the `Location` header of the un-followed redirect
 * @returns the version with its leading `v` stripped, or null
 */
export function versionFromLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const segment = location.split("?")[0].split("#")[0].replace(/\/+$/, "").split("/").pop() ?? "";
  const tag = segment.startsWith("v") ? segment.slice(1) : segment;
  // A tag has to look like a version: `releases/latest` on a repository with no
  // release redirects to the releases page itself, whose last segment is
  // `releases`, and reading that as a version would offer somebody an upgrade to
  // it.
  return /^\d+\.\d+\.\d+/.test(tag) ? tag : null;
}

/**
 * Whether this path is a compiled binary rather than an interpreter running the
 * source, which is what decides whether there is anything here to replace.
 *
 * **Asked of the path rather than of `import.meta.main`**, which is true either
 * way. A compiled binary's `execPath` is the program; running from source it is
 * the `node` or `bun` that started it.
 *
 * **The names have to be generous, because the wrong answer is destructive.** A
 * name this does not recognise reads as compiled, and a compiled binary is one
 * `upgrade` renames over — so Debian's `nodejs` and a versioned `node22` being
 * missed does not fail an upgrade, it renames a downloaded `mdbrain` over the
 * machine's interpreter. It cannot be a positive test for `mdbrain` instead: the
 * binary is supported under any name, which is why `execPath` is read at all.
 */
export function isCompiledExecPath(execPath: string): boolean {
  return !/[\\/](node|nodejs|bun)[0-9._-]*(\.exe)?$/i.test(execPath);
}

/** The release asset this target's binary ships in. */
export const assetName = (target: string): string => `mdbrain-${target}.tar.gz`;

/** What the binary is called inside that archive, and on disk. */
export const binaryName = (platform: UpgradePlatform): string => (platform === "win32" ? "mdbrain.exe" : "mdbrain");

/**
 * The published SHA-256 for one asset, read from `checksums.txt`.
 *
 * The file is `sha256sum`'s own output — a hash, whitespace, the file name —
 * and an asset it does not mention is a refusal rather than a pass. Matched on
 * the exact name: a prefix match would let `mdbrain-linux-x64.tar.gz` be
 * verified against `mdbrain-linux-x64-musl.tar.gz`'s line, which is the one
 * pair in the release where that mistake is silent and fatal.
 *
 * @returns the lower-cased hash, or null when the asset is not listed
 */
export function publishedChecksum(text: string, asset: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match && match[2] === asset) return match[1].toLowerCase();
  }
  return null;
}

/**
 * One move in the replace, named rather than described.
 *
 * `rename` is the only verb: every step is a rename within one directory, which
 * is what makes each of them atomic and what §2c's constraint about where the
 * download lands is protecting.
 */
export interface ReplaceStep {
  readonly kind: "rename";
  readonly from: string;
  readonly to: string;
  /** Why this step is here, said in the plan so a reader of a failure has it. */
  readonly because: string;
}

/**
 * The moves that put the staged binary in place, in the order they must run.
 *
 * **POSIX is one step and Windows is two, and the difference is not stylistic.**
 * A rename onto an occupied path is a delete of that path, and Windows will not
 * delete a running image — but what it locks a running executable against is
 * writes and deletes rather than renames, and the lock follows the file object
 * and not the path. So the running binary is renamed out of the way first and
 * the staged file is renamed into the vacated path. On POSIX `rename(2)` unlinks
 * the old file and unlinking a running binary is permitted, so the second step
 * is the whole of it.
 *
 * **Writing the new bytes at `execPath` directly is not an option on either
 * platform**, for two different reasons — `ETXTBSY` on Linux, the delete refusal
 * on Windows — which is why staging and renaming is the route rather than the
 * tidy version of one.
 *
 * @param platform the platform the replace is running on
 * @param execPath the running binary's own path, which is what is replaced
 * @param staged where the verified new binary is sitting, in the same directory
 * @returns the steps in order; a caller runs them and stops at the first failure
 */
export function replaceSteps(platform: UpgradePlatform, execPath: string, staged: string): ReplaceStep[] {
  const moveIn: ReplaceStep = {
    kind: "rename",
    from: staged,
    to: execPath,
    because: "the staged binary takes the running one's place",
  };
  if (platform !== "win32") return [moveIn];
  return [
    {
      kind: "rename",
      from: execPath,
      to: oldPathFor(execPath),
      because: "Windows will not delete a running image, and a rename onto an occupied path is a delete of it",
    },
    moveIn,
  ];
}

/**
 * Where the displaced binary is left on Windows.
 *
 * Beside the binary rather than in a temporary directory, because the sweep that
 * eventually removes it runs from `execPath` and has nowhere else to look.
 */
export const oldPathFor = (execPath: string): string => `${execPath}.old`;

/**
 * How to undo the steps that did run, when a later one failed.
 *
 * **The asymmetry this exists for.** POSIX is one step, so a failure there has
 * moved nothing and the install is untouched. Windows is two, and a failure on
 * the second one has already displaced the running binary — leaving a machine
 * with no `mdbrain` on `PATH` at all, which is a worse outcome than the upgrade
 * not happening and is *caused* by the upgrade rather than merely not prevented
 * by it. Every step is a rename within one directory, so the undo of one is the
 * same rename read backwards, and the undo of the displacing step in particular
 * is the self-rename §2b measured as working.
 *
 * @param done the steps that completed, in the order they ran
 * @returns their reverses, newest first; empty when nothing had moved
 */
export function rollbackSteps(done: readonly ReplaceStep[]): ReplaceStep[] {
  return [...done].reverse().map((step) => ({
    kind: "rename" as const,
    from: step.to,
    to: step.from,
    because: `undoing: ${step.because}`,
  }));
}

/**
 * What the install was left as when a replace failed — the fact the sentence has
 * to carry, kept apart from the wording so both are checkable.
 *
 * `stranded` is the case worth naming: the rollback itself failed, so the only
 * copy of a working binary is sitting under another name, and the one thing the
 * person needs is that name.
 */
export type ReplaceRecovery =
  | { kind: "untouched" }
  | { kind: "restored"; binary: string }
  | { kind: "stranded"; binary: string; at: string };

/**
 * The sentence a failed replace ends with.
 *
 * It always says what is on disk now, because *the replace failed* alone leaves
 * the reader unable to tell whether their install still works — and on Windows,
 * for the one failure that matters, it does not unless something says where the
 * binary went.
 *
 * @param reason the underlying error's own message
 * @param recovery what the install was left as
 */
export function replaceFailureMessage(reason: string, recovery: ReplaceRecovery): string {
  const head = `The replace failed: ${reason}.`;
  if (recovery.kind === "untouched") return `${head} Nothing was moved, so the installed mdbrain is the one that was already there.`;
  if (recovery.kind === "restored") return `${head} The mdbrain that was already installed has been put back at ${recovery.binary}.`;
  return `${head} Worse, putting the old one back failed too — your working mdbrain is at ${recovery.at}, and renaming it to ${recovery.binary} restores the install.`;
}

/**
 * How this install is upgraded, which is what `--check` has to say once it has
 * reported that a new version exists.
 *
 * **`--check` reports from anywhere**, including from an install this command
 * may not replace and from a source checkout — asking what is published changes
 * nothing and is a fair question in both. What must not happen is that it then
 * advises a command that would refuse.
 *
 * @param channel how this binary arrived
 * @param isCompiled whether there is an installed binary at all
 */
export function howToUpgrade(channel: Channel, isCompiled: boolean): string {
  if (channel !== "direct") return `Run \`${PACKAGER_COMMAND[channel]}\`, which owns this install.`;
  if (!isCompiled) return "This is running from source, so upgrade the checkout with git rather than with `mdbrain upgrade`.";
  return "Run `mdbrain upgrade` to replace it.";
}

/** What `upgrade` decided to do, before it did any of it. */
export type UpgradeDecision =
  | { kind: "refused"; message: string }
  | { kind: "current"; version: string }
  | { kind: "upgrade"; from: string; to: string };

/**
 * Whether there is anything to do, asked before anything is downloaded.
 *
 * **The version check is not an optimisation.** Without it `upgrade` fetches
 * 38.6 MB to discover it is already current, which is the ordinary case for
 * anybody who runs it out of habit.
 *
 * A latest that is merely *different* counts as an upgrade rather than only a
 * greater one: tags are compared as text because this reads a tag rather than a
 * semantic version, and telling somebody they are on a version the release no
 * longer publishes is more useful than silently doing nothing.
 *
 * @param channel how this binary arrived
 * @param current this binary's own `VERSION`
 * @param latest the tag the lookup found
 */
export function decideUpgrade(channel: Channel, current: string, latest: string): UpgradeDecision {
  const refusal = channelRefusal(channel);
  if (refusal !== null) return { kind: "refused", message: refusal };
  if (current === latest) return { kind: "current", version: current };
  return { kind: "upgrade", from: current, to: latest };
}

/**
 * The sentence `upgrade` ends with, printed whatever happened to a running
 * `mdbrain run`.
 *
 * **Unconditional, and that is the decision.** Whether a run is up is cheap to
 * detect on Windows and would mean scanning `/proc` on POSIX, and a sentence
 * that appeared on one platform only would read as *no run is up* rather than as
 * *this platform cannot tell*. The running process keeps executing the old image
 * either way and picks the new one up when it is next started, so there is
 * nothing for `upgrade` to stop.
 */
export const RUNNING_RUN_NOTICE =
  "A `mdbrain run` that is already going keeps the old version until you restart it.";
