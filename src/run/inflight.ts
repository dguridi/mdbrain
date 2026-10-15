// The in-flight record: one file per `run` session that has started and not yet
// ended, under the state root.
//
// **What it is for is the one thing `runs.jsonl` cannot say.** The run log gets a
// row when a session *ends*, so a runner that dies mid-session leaves nothing
// behind it at all — and that is exactly the session a person would want back.
// A file written when the harness starts and removed after the row is written is
// therefore present for precisely the sessions no ending was recorded for, with
// no log to fold and nothing to compare.
//
// **One file per session rather than rows in one file**, because the writers are
// concurrent: a runner's parallel sessions, and a resume in another window. Two
// writers of one file is the hazard the configuration path is arranged to avoid,
// and separate files make it impossible rather than unlikely.
//
// **State, never config, and never a secret.** It names sessions that happened on
// this machine, and holds no key, no prompt and nothing the server said beyond
// the claim's own id — the prompt is already in the transcript, which is the
// harness's.
//
// The record is read purely and written impurely, the split `log.ts` has.

import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { stateDir, type PathEnv } from "../config/paths.ts";

/** One session that started and has not ended, as the file holds it. */
export interface InFlightRecord {
  /** The claim id, which is also the harness's session id and the file's name. */
  claim: string;
  /**
   * The config entry's id rather than only its name, so a renamed agent still
   * matches its own sessions and a new agent made under an old name does not.
   */
  agentEntryId: string;
  /** The agent's name when the session started, for the picker's row. */
  agent: string;
  workspace: string;
  /** The brain's name when the runner knew it; cosmetic, like the working line's. */
  brain: string | null;
  cwd: string;
  startedAt: string;
  /**
   * The `mdbrain` process running the session, or null once nothing is.
   *
   * Null is what a resume that ended badly leaves: its record is kept so the
   * session can be picked up again, and an owner still named on it would read as
   * *still running* for as long as that process lived — which, for a resume
   * started from a long-lived runner's view, is days.
   */
  ownerPid: number | null;
  /**
   * The harness itself, once the spawn reported one. Kept beside the owner
   * because a POSIX session is detached and can outlive the runner that started
   * it, which is a session still running under a dead owner.
   */
  harnessPid: number | null;
  /** How many times a person has picked this session up again. */
  resumes: number;
}

/** Reading, writing and listing the records — an edge, so a test needs no disk. */
export interface InFlightStore {
  write(record: InFlightRecord): Promise<void>;
  remove(claim: string): Promise<void>;
  list(): Promise<InFlightRecord[]>;
  /**
   * Take the one lock a claim has, held by whoever is resuming or dismissing it.
   *
   * @returns null once this process holds it, or the live process that does, or
   * 0 for a lock still being written, which names nobody yet
   */
  lock(claim: string, pid: number, isAlive: (pid: number) => boolean): Promise<number | null>;
  /**
   * Name the harness in the lock this process holds, once the spawn reports it,
   * so the lock can be told from one a reused pid only seems to hold.
   */
  nameHarness(claim: string, harnessPid: number): Promise<void>;
  /** Let the lock go; one that is already gone, or no longer this process's, is not a failure. */
  unlock(claim: string): Promise<void>;
}

/** Where the records live. */
export function inFlightDir(env?: PathEnv): string {
  return join(stateDir(env), "inflight");
}

/**
 * A claim id is the server's, and it becomes a file name here.
 *
 * Refused unless it is UUID-shaped, so an answer that carried a path where an id
 * belongs cannot place a file anywhere but this directory. A refusal is a write
 * that failed, which is a note and never a failed session.
 */
const CLAIM_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The file one claim's record is written to. */
export function inFlightPath(claim: string, env?: PathEnv): string {
  if (!CLAIM_SHAPE.test(claim)) throw new Error(`${claim} is not a session id this runner writes down`);
  return join(inFlightDir(env), `${claim}.json`);
}

/**
 * A parsed file read into a record, or null when it is not one.
 *
 * Strict on every field, because a record decides which agent a transcript is
 * resumed as: a file that only half-parses is one whose agent cannot be trusted.
 */
export function readRecord(value: unknown): InFlightRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === "string" && field !== "";
  const pid = (field: unknown) => typeof field === "number" && Number.isInteger(field) && field > 0;
  if (!text(v.claim) || !CLAIM_SHAPE.test(v.claim as string)) return null;
  if (!text(v.agentEntryId) || !text(v.agent) || !text(v.workspace) || !text(v.cwd) || !text(v.startedAt)) return null;
  if (!(v.brain === null || typeof v.brain === "string")) return null;
  if (!(v.ownerPid === null || pid(v.ownerPid)) || !(v.harnessPid === null || pid(v.harnessPid))) return null;
  if (typeof v.resumes !== "number" || !Number.isInteger(v.resumes) || v.resumes < 0) return null;
  return {
    claim: v.claim as string,
    agentEntryId: v.agentEntryId as string,
    agent: v.agent as string,
    workspace: v.workspace as string,
    brain: v.brain as string | null,
    cwd: v.cwd as string,
    startedAt: v.startedAt as string,
    ownerPid: v.ownerPid as number | null,
    harnessPid: v.harnessPid as number | null,
    resumes: v.resumes as number,
  };
}

/**
 * The live process a record's session is still running under, or null when
 * neither is alive.
 *
 * PID reuse can make a dead session look alive, and that failure is the safe
 * one: a session drawn as *still running* that is not, which a dismissal clears.
 * The other way round would hand one transcript to two writers.
 */
export function runningPid(record: InFlightRecord, isAlive: (pid: number) => boolean): number | null {
  if (record.ownerPid !== null && isAlive(record.ownerPid)) return record.ownerPid;
  if (record.harnessPid !== null && isAlive(record.harnessPid)) return record.harnessPid;
  return null;
}

/**
 * Whether a process is alive, by signal 0.
 *
 * `EPERM` is alive — the process exists and belongs to somebody else — and every
 * other failure is not.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Write one record, replacing any earlier one for the same claim.
 *
 * Written beside and renamed into place, so a reader listing the directory never
 * meets half a file and drops a session it could have offered.
 */
export async function writeInFlight(record: InFlightRecord, env?: PathEnv): Promise<void> {
  const path = inFlightPath(record.claim, env);
  await mkdir(inFlightDir(env), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  await writeFile(partial, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(partial, path);
}

/**
 * What a lock file holds.
 *
 * **A token beside the pid**, because a pid does not name one taking of a lock.
 * The token is what a takeover is keyed by, and what a release checks, so a
 * process never lets go of a lock somebody else has taken since.
 *
 * **The harness, once it runs**, because the holder's pid alone cannot tell a
 * live resume from a killed one whose pid the system has handed on: both name a
 * live process. A second pid that died with the first makes a reused one
 * outvoted rather than believed.
 */
export interface LockHolding {
  pid: number;
  token: string;
  /** Epoch milliseconds; what bounds a lock that never came to name a harness. */
  takenAt: number;
  harnessPid: number | null;
}

/**
 * How long a lock may go without naming a harness, while its holder is still
 * checking, before it is taken to be abandoned. The checks take seconds, so this
 * only decides how long a process killed during them, whose pid was then reused,
 * keeps its session out of reach.
 */
export const UNNAMED_LOCK_MS = 10 * 60_000;

/**
 * How long a takeover's guard may be held, and how long a lock file that does
 * not read as a holding is still taken to be one being written; both are a few
 * file operations.
 */
export const GUARD_MS = 30_000;

/**
 * Whether a claim's lock no longer protects anything.
 *
 * **Stale once either of its processes is gone.** A killed resume takes its
 * harness with it, and the system can hand either pid on afterwards, so a lock
 * trusting only one of them strands its session as soon as that one is reused.
 * Needing both gone would make the lock only as good as the likelier reuse;
 * needing either makes a strand wait for both pids to be reused at once.
 *
 * What that gives up is a POSIX harness that outlived a holder killed on its
 * own: its lock is stale while its session still runs. Nothing is handed to two
 * writers by it **only while the record names that harness**, since then a
 * resume is refused as *still running* and a dismissal goes through the picker's
 * warning. A record whose write of the harness failed cannot say so, and its
 * lock holds on the harness alone instead.
 *
 * **The record stands in for a lock whose naming failed.** A lock with no
 * harness, held by the process the record names as owner, is judged by the
 * harness the record names, the same way.
 *
 * **A lock with no harness anywhere is aged only while its holder is still
 * checking.** Once the holder has written the record as the session's owner, the
 * session has started, and a lock must not expire under a live session, so the
 * age bound is waived for it.
 *
 * @param record the claim's in-flight record as it stands, or null when there is none to read
 */
export function lockIsStale(holding: LockHolding, isAlive: (pid: number) => boolean, now: number, record: Pick<InFlightRecord, "ownerPid" | "harnessPid"> | null): boolean {
  const recordOwns = record !== null && record.ownerPid === holding.pid;
  const harness = holding.harnessPid ?? (recordOwns ? record.harnessPid : null);
  if (harness !== null) {
    if (!isAlive(harness)) return true;
    if (isAlive(holding.pid)) return false;
    return record === null || record.harnessPid === harness;
  }
  if (!isAlive(holding.pid)) return true;
  return !recordOwns && now - holding.takenAt > UNNAMED_LOCK_MS;
}

/** A lock file's text read into a holding, or null when it is not one. */
export function readHolding(text: string): LockHolding | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const pid = (field: unknown) => typeof field === "number" && Number.isInteger(field) && field > 0;
  if (!pid(v.pid) || typeof v.token !== "string" || !/^[0-9a-f]{16}$/.test(v.token)) return null;
  if (typeof v.takenAt !== "number" || !(v.harnessPid === null || pid(v.harnessPid))) return null;
  return { pid: v.pid as number, token: v.token, takenAt: v.takenAt, harnessPid: v.harnessPid as number | null };
}

/** The locks this process holds, by path, so a release and a naming know their own token. */
const held = new Map<string, LockHolding>();

/**
 * Locks this process failed to let go, by path, with the token it took them
 * under. Such a lock names a live process — this one — and would otherwise
 * refuse this same process for as long as it lives.
 */
const stranded = new Map<string, string>();

function lockPath(claim: string, env?: PathEnv): string {
  return `${inFlightPath(claim, env)}.lock`;
}

/** The link failures that mean the filesystem has no hard links, rather than that the lock is held. */
const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * Create a file with its whole content, or report that one is already there.
 *
 * Written beside and linked into place rather than created with `wx`, so no
 * reader ever meets a lock that exists and is still empty — which would read as
 * a holder that names nobody, and be taken over from under its creator. A state
 * root on a filesystem without hard links (FAT, some network shares) falls back
 * to `wx`, which leaves that moment open but still lets a resume happen.
 *
 * @returns null once the file is this one, or, when one is already there, the
 * filesystem's own clock: the time the file written beside it was stamped with.
 * A lock is dated against that rather than this process's clock, because the
 * filesystems the `wx` fallback runs on stamp files by a server's clock, or in
 * local time.
 */
async function createExclusively(path: string, content: string): Promise<number | null> {
  const partial = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(partial, content, "utf8");
  let clock: number;
  try {
    clock = (await stat(partial)).mtimeMs;
    try {
      await link(partial, path);
      return null;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return clock;
      if (code === undefined || !NO_LINKS.has(code)) throw cause;
    }
  } finally {
    await rm(partial, { force: true });
  }
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return null;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return clock;
    throw cause;
  }
}

/**
 * A lock file as it stands, or undefined once it is gone.
 *
 * `key` names this one taking of it: its token, or, for a file that does not
 * read as a holding, a digest of what it holds. `modifiedAt` is the file's
 * stamp, by the filesystem's clock, which is all that can date a file that does
 * not parse.
 */
async function readLock(path: string): Promise<{ holding: LockHolding | null; key: string; modifiedAt: number } | undefined> {
  let text: string;
  let modifiedAt: number;
  try {
    // Read and stamped by path rather than through one open handle, so a reader
    // holds nothing that would make a Windows rename or remove of the lock fail.
    text = await readFile(path, "utf8");
    modifiedAt = (await stat(path)).mtimeMs;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  const holding = readHolding(text);
  return { holding, key: holding?.token ?? `x${createHash("sha256").update(text).digest("hex").slice(0, 15)}`, modifiedAt };
}

/** Replace a lock this process holds, whole. */
async function replaceLock(path: string, holding: LockHolding): Promise<void> {
  const partial = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(partial, JSON.stringify(holding), "utf8");
  await rename(partial, path);
}

/** Remove a lock only while it is still the taking this token names. */
async function release(path: string, token: string): Promise<void> {
  const found = await readLock(path);
  if (found?.holding?.token === token) await rm(path, { force: true });
}

/**
 * Take the lock at `path`, taking over one that is stale.
 *
 * **A takeover goes through a guard keyed by the stale taking**, `<path>.<key>`,
 * created exclusively. Only the guard's winner removes the stale file, and only
 * while it still holds that same key — and no fresh lock can carry a dead one's
 * token — so two takers can no longer both read the dead holder, and one delete
 * the other's new lock. A guard whose taker died is itself taken over the same
 * way, one name deeper.
 *
 * @returns null once `mine` holds it, or the pid that does (0 when none can be named)
 */
async function take(path: string, mine: LockHolding, stale: (holding: LockHolding) => boolean, isAlive: (pid: number) => boolean, now: () => number, depth = 0): Promise<number | null> {
  if (depth > 3) return 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clock = await createExclusively(path, JSON.stringify(mine));
    if (clock === null) return null;
    const found = await readLock(path);
    // Gone between the create and the read: the next attempt takes it.
    if (found === undefined) continue;
    const { holding, key } = found;
    // Left behind by this same process, whose release failed: let it go and take it afresh.
    if (stranded.get(path) === key) {
      await release(path, key);
      stranded.delete(path);
      continue;
    }
    if (holding !== null && !stale(holding)) return holding.pid;
    // A file that does not parse is most likely one the `wx` fallback has created
    // and not yet written, so it is left to its creator for a moment; only one
    // that stays unreadable is corrupt, and taken over rather than stranding the
    // session for good.
    if (holding === null && clock - found.modifiedAt <= GUARD_MS) return 0;

    const guard = `${path}.${key}`;
    const guardStale = (other: LockHolding) => !isAlive(other.pid) || now() - other.takenAt > GUARD_MS;
    // Aged from its own creation, not from when this take began.
    const guarded = await take(guard, { ...mine, takenAt: now() }, guardStale, isAlive, now, depth + 1);
    // Another process is taking this one over; it is the holder a moment from now.
    if (guarded !== null) return guarded;
    try {
      const still = await readLock(path);
      if (still !== undefined && still.key === key) await rm(path, { force: true });
    } finally {
      await release(guard, mine.token);
    }
  }
  return (await readLock(path))?.holding?.pid ?? 0;
}

/**
 * Remove the guards a takeover left when its taker died mid-way.
 *
 * Safe once this process holds the lock: every guard is keyed by a taking that
 * is no longer the lock, so a taker still holding one finds the key gone and
 * removes nothing. A guard keyed by this process's own taking is left alone:
 * its taker has judged this lock stale and is mid-takeover, and removing its
 * guard would let a second taker in beside it.
 *
 * @param path the lock file, whose guards are named `<path>.<key>`
 * @param token this process's taking of it
 */
export async function sweepGuards(path: string, token: string, env?: PathEnv): Promise<void> {
  const prefix = `${basename(path)}.`;
  const names = await readdir(inFlightDir(env)).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(prefix) || name.endsWith(".tmp") || name.startsWith(`${prefix}${token}`)) continue;
    await rm(join(inFlightDir(env), name), { force: true }).catch(() => {});
  }
}

/** The claim's in-flight record, or null when there is none to read. */
async function readInFlight(claim: string, env?: PathEnv): Promise<InFlightRecord | null> {
  try {
    return readRecord(JSON.parse(await readFile(inFlightPath(claim, env), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Take a claim's lock by creating its file exclusively.
 *
 * **Why a lock and not only the running check.** A resume reads the records,
 * spends seconds on its preflight, and only then writes; two windows choosing
 * one session inside that gap would both pass the check and hand one transcript
 * to two writers. An exclusive create is the one step two processes cannot both
 * win. A stale lock ({@link lockIsStale}) is taken over, so a crash strands a
 * session behind it only once both of its pids have been reused, or one of them
 * where only one was ever written down: the harness's, where the record could
 * not be told the harness, and the holder's, where it was killed after writing
 * the record and before naming its harness.
 *
 * @param now the clock a lock's age is read against
 * @returns null once this process holds it, or the live process that does, or
 * 0 for a lock still being written, which names nobody yet
 */
export async function lockInFlight(claim: string, pid: number, isAlive: (pid: number) => boolean, env?: PathEnv, now: () => number = Date.now): Promise<number | null> {
  const path = lockPath(claim, env);
  await mkdir(inFlightDir(env), { recursive: true });
  const mine: LockHolding = { pid, token: randomBytes(8).toString("hex"), takenAt: now(), harnessPid: null };
  const record = await readInFlight(claim, env);
  const holder = await take(path, mine, (holding) => lockIsStale(holding, isAlive, now(), record), isAlive, now);
  if (holder === null) {
    held.set(path, mine);
    await sweepGuards(path, mine.token, env);
  }
  return holder;
}

/**
 * Name the harness in a lock this process holds; one it no longer holds is left alone.
 *
 * The check and the rename are two steps, so a takeover landing between them is
 * overwritten. That needs this live lock to have been judged stale already,
 * which {@link lockIsStale} does to an unnamed lock in two cases: one whose holder
 * has not yet written its record, after {@link UNNAMED_LOCK_MS}, and one whose
 * holder's record already names a harness that has died. The second needs the
 * record's write to win its race with this naming and the harness to exit at
 * once, and a second resume is still refused by the running check then, because
 * the record's owner is alive.
 */
export async function nameHarnessInLock(claim: string, harnessPid: number, env?: PathEnv): Promise<void> {
  const path = lockPath(claim, env);
  const mine = held.get(path);
  if (mine === undefined) return;
  if ((await readLock(path))?.holding?.token !== mine.token) {
    held.delete(path);
    return;
  }
  const named = { ...mine, harnessPid };
  await replaceLock(path, named);
  held.set(path, named);
}

/**
 * Let a claim's lock go, if this process still holds it.
 *
 * A release that fails is remembered, so this process can take the lock again
 * rather than be refused by its own pid.
 */
export async function unlockInFlight(claim: string, env?: PathEnv): Promise<void> {
  const path = lockPath(claim, env);
  const mine = held.get(path);
  held.delete(path);
  if (mine === undefined) return;
  try {
    await release(path, mine.token);
  } catch (cause) {
    stranded.set(path, mine.token);
    throw cause;
  }
}

/** Remove one claim's record; a record that is already gone is not a failure. */
export async function removeInFlight(claim: string, env?: PathEnv): Promise<void> {
  await rm(inFlightPath(claim, env), { force: true });
}

/**
 * Every record that reads as one, in no particular order.
 *
 * A file that does not is skipped rather than reported: it is not a session this
 * build can resume, and a picker refusing to open over one unreadable file would
 * be holding every other session hostage to it.
 */
export async function listInFlight(env?: PathEnv): Promise<InFlightRecord[]> {
  let names: string[];
  try {
    names = await readdir(inFlightDir(env));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const records: InFlightRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = readRecord(JSON.parse(await readFile(join(inFlightDir(env), name), "utf8")));
      if (record !== null && `${record.claim}.json` === name) records.push(record);
    } catch {
      // Unreadable or not JSON: skipped, for the reason above.
    }
  }
  return records;
}

/** The store as the process's own disk. */
export const diskInFlight: InFlightStore = {
  write: (record) => writeInFlight(record),
  remove: (claim) => removeInFlight(claim),
  list: () => listInFlight(),
  lock: (claim, pid, isAlive) => lockInFlight(claim, pid, isAlive),
  nameHarness: (claim, harnessPid) => nameHarnessInLock(claim, harnessPid),
  unlock: (claim) => unlockInFlight(claim),
};
