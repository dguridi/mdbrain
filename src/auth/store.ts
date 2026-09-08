// Reading and writing the one file that holds the session.
//
// Thin on purpose: what a session IS and what to do about one are decided in
// `session.ts`, which has no disk in it. This is only the three operations that
// touch the filesystem, plus the one thing they must get right — a session file
// is written owner-only where the platform has such a notion, and no pretence is
// made where it does not.

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** Remove the session file. Absent is the outcome asked for, not a failure. */
export async function clearSession(env?: PathEnv): Promise<void> {
  await rm(sessionPath(env), { force: true });
}
