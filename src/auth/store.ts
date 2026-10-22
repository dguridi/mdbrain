// Reading and writing the one file that holds the session.
//
// Thin on purpose: what a session IS and what to do about one are decided in
// `session.ts`, which has no disk in it. This is only the three operations that
// touch the filesystem, plus the one thing they must get right — a session file
// is written owner-only where the platform has such a notion, and no pretence is
// made where it does not.

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionPath, type PathEnv } from "../config/paths.ts";
import { parseSession, type StoredSession } from "./session.ts";

/** What was on disk, told apart so the two failures can read differently. */
export type LoadedSession =
  | { kind: "session"; session: StoredSession }
  | { kind: "none" }
  | { kind: "unreadable" };

/**
 * Read the stored session.
 *
 * "Absent" and "there but not a session" are separate answers because they mean
 * different things to a person: one is *you have not signed in*, the other is
 * *something is wrong with the file*.
 */
export async function loadSession(env?: PathEnv): Promise<LoadedSession> {
  let text: string;
  try {
    text = await readFile(sessionPath(env), "utf8");
  } catch (cause) {
    // Only `ENOENT` is *absent*. A permission change, a lock or a Windows
    // sharing violation is a session that exists and cannot be read, and
    // answering "you are not signed in" about one is how `logout` comes to
    // revoke nothing, delete nothing, and report success.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable" };
  }
  const session = parseSession(text);
  return session ? { kind: "session", session } : { kind: "unreadable" };
}

/**
 * Write the session, replacing whatever was there.
 *
 * `mode: 0o600` is owner-only on the platforms that have permissions, and is
 * quietly ignored on Windows — which is the Claude CLI's own arrangement and the
 * one this is matching. The directory is created if it is not there, since a
 * first login is the common case.
 *
 * **The mode is then applied again, because `writeFile` only sets one on the
 * open that creates the file.** A `session.json` that already exists with looser
 * permissions — restored from a backup, unpacked from an archive, made by hand —
 * would otherwise keep them while every refresh wrote fresh tokens into it, and
 * the promise above would be false exactly where it matters. A platform that
 * refuses the change is not allowed to fail the save: the session is already
 * written by then, and a login that reports failure over a session it stored is
 * the worse of the two outcomes.
 */
export async function saveSession(session: StoredSession, env?: PathEnv): Promise<void> {
  const path = sessionPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows has no mode to set, and a filesystem that refuses one has already
    // taken the bytes.
  }
}

/** How long a refresh lock may stand before another process takes it over: far
 *  longer than a refresh takes, so only a holder that died is overtaken. */
export const SESSION_LOCK_STALE_MS = 30_000;

/** How often a process waiting on the lock looks again. */
const SESSION_LOCK_POLL_MS = 50;

/**
 * Runs `work` while holding the lock beside the session file.
 *
 * **A refresh rotates the refresh token, so two processes refreshing at once
 * leave one of them holding a token the server has already replaced.** A script
 * calling `mdbrain upload` in a loop beside a running `mdbrain run` makes that
 * likely, and depending on the project's reuse interval the loser's next refresh
 * ends the session. The lock serialises the refresh, and the caller re-reads the
 * file once it holds it, so the second process finds the first one's fresh pair
 * and has nothing left to refresh.
 *
 * The lock is a file created exclusively, which every platform this ships on
 * makes atomic, holding a token of this taking. **A lock is only ever removed by
 * whoever proves it is still the taking they mean**: the holder releases it only
 * while it still holds the holder's token, and a lock older than
 * `SESSION_LOCK_STALE_MS` — a holder that died, or one whose refresh hung — is
 * taken over through a guard file named after that taking's token, created
 * exclusively, so of two processes that both find it stale only one removes it,
 * and neither can remove the fresh lock the other made in its place.
 *
 * A create refused for a reason that can pass — Windows answers `EPERM` or
 * `EBUSY` while another process is deleting the file — is asked again. One that
 * means the lock cannot be made at all, a read-only or missing directory, runs
 * the work without it, because a command that refused to refresh would end the
 * very session the lock exists to protect.
 */
export async function withSessionLock<T>(work: () => Promise<T>, env?: PathEnv): Promise<T> {
  const path = `${sessionPath(env)}.lock`;
  const token = randomBytes(8).toString("hex");
  const held = await takeLock(path, token);
  try {
    return await work();
  } finally {
    if (held) await releaseLock(path, token).catch(() => undefined);
  }
}

/** Create errors that say the lock may be there in a moment, or may be gone. */
const TRANSIENT = new Set(["EEXIST", "EPERM", "EBUSY", "EACCES"]);

/** Create errors that say no lock can be made here at all. */
const UNLOCKABLE = new Set(["EROFS", "ENOENT", "ENOTDIR", "ENOSPC"]);

/**
 * Take the lock, waiting for a live holder and taking over a stale one.
 *
 * `EACCES` is read as transient rather than as a directory refusing writes,
 * because Windows answers it for a file pending deletion; a directory that truly
 * refuses is found out by the wait bound, after which the work runs unlocked.
 *
 * @returns whether this process holds it
 */
async function takeLock(path: string, token: string): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    try {
      await writeFile(path, token, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code ?? "";
      if (UNLOCKABLE.has(code) || !TRANSIENT.has(code)) return false;
    }
    // Waited out a holder that is alive and making no progress for longer than
    // any refresh takes, and failed to take it over: the work goes ahead without.
    if (Date.now() - started > 2 * SESSION_LOCK_STALE_MS) return false;
    const found = await readLock(path);
    if (found !== null && Date.now() - found.modifiedAt > SESSION_LOCK_STALE_MS) {
      await takeOver(path, found.text);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_LOCK_POLL_MS));
  }
}

/** The lock's text and stamp, or null once it is gone or cannot be read. */
async function readLock(path: string): Promise<{ text: string; modifiedAt: number } | null> {
  try {
    const text = await readFile(path, "utf8");
    return { text, modifiedAt: (await stat(path)).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Remove a stale lock, through a guard so only one process does.
 *
 * The guard is named after the stale taking's own text, so it guards that taking
 * and no other; its winner removes the lock only if it still holds that text,
 * then lets the guard go. A guard left by a taker that died is itself stale after
 * the same bound and removed, which lets the next taker in.
 */
async function takeOver(path: string, staleText: string): Promise<void> {
  const guard = `${path}.${createHash("sha256").update(staleText).digest("hex").slice(0, 16)}`;
  try {
    await writeFile(guard, "", { encoding: "utf8", flag: "wx" });
  } catch {
    const left = await readLock(guard);
    if (left !== null && Date.now() - left.modifiedAt > SESSION_LOCK_STALE_MS) await rm(guard, { force: true }).catch(() => undefined);
    return;
  }
  try {
    const still = await readLock(path);
    if (still !== null && still.text === staleText) await rm(path, { force: true });
  } finally {
    await rm(guard, { force: true }).catch(() => undefined);
  }
}

/** Remove the lock only while it is still this taking. */
async function releaseLock(path: string, token: string): Promise<void> {
  const found = await readLock(path);
  if (found?.text === token) await rm(path, { force: true });
}

/** Remove the session file. Absent is the outcome asked for, not a failure. */
export async function clearSession(env?: PathEnv): Promise<void> {
  await rm(sessionPath(env), { force: true });
}
