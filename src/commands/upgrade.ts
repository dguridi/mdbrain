// `mdbrain upgrade` — replace this binary with the latest published one.
//
// **A command a person types.** Nothing here runs unprompted: no background
// updater, no check that replaces anything, and nothing that upgrades a `run`
// already in progress.
//
// **The logic is in the binary and not in the install scripts**, and roughly
// forty lines are duplicated between the two knowingly. The script route fails
// on Windows by construction — the process holding the lock would be the
// script's own parent, which it cannot stop — and the scripts choose an install
// directory fresh by writability rather than replacing the binary that is
// running, which can leave two `mdbrain`s with `PATH` order deciding which one
// answers. **The duplication is affordable because the checksum is an integrity
// check and not a trust anchor**: `checksums.txt` and the artifact come from the
// same release over the same connection and nothing signs either, so a second
// implementation risks getting a hash comparison wrong twice rather than a trust
// decision wrong twice. **If anything is ever signed that reasoning expires.**
//
// This file is the order and the edges; every judgement in it is `upgrade/plan.ts`.

import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { CommandSpec } from "../cli.ts";
import { CHANNEL, TARGET, VERSION } from "../version.ts";
import { downloadUrl, latestVersion } from "../upgrade/latest.ts";
import {
  assetName,
  binaryName,
  decideUpgrade,
  howToUpgrade,
  isCompiledExecPath,
  publishedChecksum,
  replaceFailureMessage,
  replaceSteps,
  rollbackSteps,
  RUNNING_RUN_NOTICE,
  tarExtraction,
  type ReplaceRecovery,
  type ReplaceStep,
} from "../upgrade/plan.ts";

/** What `upgrade` needs from outside itself, so a test can stand each one in. */
export interface UpgradeDeps {
  /** The running binary's own path. Never a directory this command chose. */
  execPath: string;
  platform: NodeJS.Platform;
  /** Whether this is a compiled binary at all — `node src/main.ts` is not. */
  isCompiled: boolean;
  fetch: typeof fetch;
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
  /** Unpacks the archive into the directory it is given; resolves to where the
   *  member landed, which is inside that directory and never beside the binary. */
  extract: (archive: string, into: string, member: string) => Promise<string>;
  /** Makes the staging directory, and removes it whatever happened afterwards. */
  makeDir: (path: string) => Promise<void>;
  removeDir: (path: string) => Promise<void>;
  makeExecutable: (path: string) => Promise<void>;
}

/** Runs `tar` over the staged archive and answers where the member landed. */
const extractWithTar = (platform: NodeJS.Platform, archive: string, into: string, member: string): Promise<string> =>
  new Promise((resolve, reject) => {
    // `tar` is not a new dependency: the Windows install script already refuses
    // a machine without it, and it is spawnable from inside a compiled binary.
    // What the machine supplies under that name is not fixed, though, which is
    // what `tarExtraction` is shaped around.
    const { argv, cwd } = tarExtraction(platform, archive, into, member);
    const child = spawn("tar", [...argv], { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(join(into, member)) : reject(new Error(`tar exited ${code}`))));
  });

export const defaultUpgradeDeps: UpgradeDeps = {
  execPath: process.execPath,
  platform: process.platform,
  isCompiled: isCompiledExecPath(process.execPath),
  fetch,
  writeBytes: (path, bytes) => writeFile(path, bytes),
  renameFile: rename,
  makeDir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  removeDir: (path) => rm(path, { recursive: true, force: true }),
  extract: (archive, into, member) => extractWithTar(process.platform, archive, into, member),
  makeExecutable: async (path) => {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, 0o755);
  },
};

/**
 * Where the download is unpacked: a directory beside the binary, on the same
 * volume, whose name nobody will mistake for a release artifact.
 *
 * It exists because the archive holds the binary under its own name, so
 * extracting into the install directory itself would write it at exactly the
 * running binary's own path — which is the one thing neither platform allows,
 * and the reason the rename is here at all.
 */
export const STAGING_DIR = ".mdbrain-upgrade";

/** What `upgrade` says where there is no binary to replace. */
export const NOT_A_BINARY_MESSAGE =
  "This is `mdbrain` running from source, so there is no installed binary to replace. Upgrade the checkout with git, or install the released binary with the one-liner in the README.";

/** What it says when the lookup could not be made. Reported, unlike the notice's. */
export const LOOKUP_FAILED_MESSAGE =
  "Could not reach GitHub to ask what the latest version is, so nothing was changed. Try again when the connection is back.";

/**
 * Put back whatever a failed replace had already moved.
 *
 * **Undoing is not optional politeness here.** On Windows the first step
 * displaces the running binary, so a failure on the second leaves the machine
 * with no `mdbrain` at all — the upgrade would have destroyed a working install
 * rather than merely failed to improve it. The undo is the exact reverse of a
 * rename inside one directory, which is the operation §2b measured as working.
 *
 * **Its own failure is reported rather than thrown**, because at that point the
 * only thing left to do is tell somebody where their binary is: this returns
 * what happened and the caller says it, so the person is never given a bare
 * *the replace failed* while their `PATH` has nothing on it.
 *
 * @param done the steps that completed, in the order they ran
 * @returns what the install was left as
 */
async function undoReplace(deps: UpgradeDeps, done: readonly ReplaceStep[]): Promise<ReplaceRecovery> {
  if (done.length === 0) return { kind: "untouched" };
  try {
    for (const step of rollbackSteps(done)) {
      await deps.renameFile(step.from, step.to);
    }
    return { kind: "restored", binary: deps.execPath };
  } catch {
    // Where the displacing step actually put it, rather than a suffix restated
    // here: the sentence has to name the file that is really on disk.
    return { kind: "stranded", binary: deps.execPath, at: done[0].to };
  }
}

/**
 * The command.
 *
 * The order is §1a's, and each step's failure is one sentence and exit 1:
 * ask, refuse or stop if current, download, verify, extract, replace, report.
 * Nothing is moved until the bytes have been verified, so a failed download and
 * a failed checksum both leave the installed binary exactly as it was.
 */
export async function runUpgrade(deps: UpgradeDeps, context: { out: (l: string) => void; err: (l: string) => void; flags: Record<string, string | boolean> }): Promise<number> {
  const { out, err, flags } = context;
  const checkOnly = flags.check === true;

  if (!deps.isCompiled && !checkOnly) {
    err(NOT_A_BINARY_MESSAGE);
    return 1;
  }

  const latest = await latestVersion(deps.fetch);
  if (latest === null) {
    err(LOOKUP_FAILED_MESSAGE);
    return 1;
  }

  // **`--check` is answered before any refusal, and that ordering is the
  // point.** Asking what is published replaces nothing, so it is a fair question
  // from a source checkout and from an install a package manager owns; a refusal
  // there would withhold the answer to the question that was actually asked.
  // What it must not do is advise a command that would then refuse, which is
  // what `howToUpgrade` decides.
  if (checkOnly) {
    if (VERSION === latest) {
      out(`mdbrain ${VERSION} is the latest version.`);
      return 0;
    }
    out(`mdbrain ${latest} is available; this is ${VERSION}. ${howToUpgrade(CHANNEL, deps.isCompiled)}`);
    return 0;
  }

  const decision = decideUpgrade(CHANNEL, VERSION, latest);
  if (decision.kind === "refused") {
    err(decision.message);
    return 1;
  }
  if (decision.kind === "current") {
    out(`mdbrain ${decision.version} is the latest version.`);
    return 0;
  }

  // **Into the install directory, never the temp directory.** A rename is only
  // cheap and atomic within a volume, so staging elsewhere turns the final step
  // into a cross-volume move.
  //
  // **Into a subdirectory of it, and that is not tidiness.** The archive holds
  // the binary under its own name, so extracting straight into the install
  // directory writes it at exactly the path the running binary occupies — which
  // is the one thing neither platform allows and the reason the rename exists.
  // A directory beside the binary keeps the extraction off that path while
  // staying on the same volume.
  const installDir = dirname(deps.execPath);
  const stagingDir = join(installDir, STAGING_DIR);
  const asset = assetName(TARGET);
  const archive = join(stagingDir, asset);

  out(`Downloading mdbrain ${decision.to} for ${TARGET}…`);
  let bytes: Uint8Array;
  let checksums: string;
  try {
    const [artifact, sums] = await Promise.all([
      deps.fetch(downloadUrl(decision.to, asset)),
      deps.fetch(downloadUrl(decision.to, "checksums.txt")),
    ]);
    if (!artifact.ok || !sums.ok) {
      // **Both bodies are let go before this gives up, and that is not tidiness.**
      // The two requests are made together, so a failure on one leaves the
      // other's body unread. Releasing it is hygiene rather than a rescue: an
      // unread body does not hold this program open, measured on both runtimes
      // against a server streaming 38 MB to a client that never reads it. What
      // does hold it open is an outstanding request, which is why the notice's
      // lookup carries a bound of its own rather than relying on this.
      artifact.body?.cancel().catch(() => {});
      sums.body?.cancel().catch(() => {});
      throw new Error(artifact.ok ? `checksums.txt answered ${sums.status}` : `the download answered ${artifact.status}`);
    }
    bytes = new Uint8Array(await artifact.arrayBuffer());
    checksums = await sums.text();
  } catch (cause) {
    err(`The download failed and nothing was changed: ${(cause as Error).message}`);
    return 1;
  }

  const want = publishedChecksum(checksums, asset);
  if (want === null) {
    err(`checksums.txt does not mention ${asset}, so the download could not be verified and nothing was changed.`);
    return 1;
  }
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) {
    err(`The download does not match its published checksum, so nothing was changed. Expected ${want}, got ${got}.`);
    return 1;
  }

  // The steps that have actually run, so a failure can be undone rather than
  // reported over. It is declared out here because the recovery happens in the
  // `catch`, where the loop's own scope is gone.
  const done: ReplaceStep[] = [];
  try {
    await deps.makeDir(stagingDir);
    await deps.writeBytes(archive, bytes);
    const staged = await deps.extract(archive, stagingDir, binaryName(deps.platform));
    if (deps.platform !== "win32") await deps.makeExecutable(staged);
    for (const step of replaceSteps(deps.platform, deps.execPath, staged)) {
      await deps.renameFile(step.from, step.to);
      done.push(step);
    }
  } catch (cause) {
    err(replaceFailureMessage((cause as Error).message, await undoReplace(deps, done)));
    return 1;
  } finally {
    // The staging directory is entirely ours, so it goes whole rather than file
    // by file — and best-effort, for the reason the leftover sweep's removal is:
    // a directory left behind is untidy, and a failure reported here would be
    // about a file nobody made and nobody can act on. The upgrade has either
    // already succeeded or already said why it did not.
    await deps.removeDir(stagingDir).catch(() => {});
  }

  out(`mdbrain ${decision.to} is installed.`);
  out(RUNNING_RUN_NOTICE);
  return 0;
}

export const upgrade: CommandSpec = {
  name: "upgrade",
  summary: "replace this binary with the latest published version",
  flags: [{ name: "check", summary: "say what is available and replace nothing" }],
  run: (context) => runUpgrade(defaultUpgradeDeps, context),
};
