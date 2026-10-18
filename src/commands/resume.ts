// `mdbrain resume` — pick up a `run` session that ended abruptly, with its
// context intact and under the agent's identity, with the person driving it.
//
// **Every resume is attended, and nothing here ever starts one on its own.** A
// unit of work is delivered at most once, and a runner that dies mid-session
// loses the work — that is the behaviour rather than a gap. What this adds is a
// better tool for the recovery that rule already names: a person waking the agent
// by hand. So there is no unattended path, no retry and no `-p`: the person
// chooses a session from a list, and the harness takes the terminal.
//
// **One path, two doors.** This command's picker and the `r` key on a failed run
// in the `run` view both end in {@link prepareResume}: the same check that the
// session is not running somewhere else, the same preflight `as` runs, the same
// attended spawn with `--resume` in place of `--session-id`. Only the way the
// session is chosen differs, and neither way takes an id somebody typed.
//
// **It writes one kind of file**, the in-flight record of the session it resumes,
// so a resume that dies is itself resumable. No `runs.jsonl` row — an attended
// session is not triggered work — and no claim, so nothing here counts against a
// ceiling or changes the record of the original session.

import type { CommandContext, CommandSpec } from "../cli.ts";
import type { AgentEntry, Config } from "../config/schema.ts";
import { loadConfig, mcpConfigPath } from "../config/store.ts";
import { configPath } from "../config/paths.ts";
import { runAttached, type AttachedEnding, type AttachedRequest } from "../run/execute.ts";
import { diskInFlight, processAlive, runningPid, type InFlightRecord, type InFlightStore } from "../run/inflight.ts";
import { beingResumedMessage, nameWidth, NO_TERMINAL_MESSAGE, NOTHING_TO_RESUME, resumeRows, rowText, stillRunningMessage, unfinishedMessage } from "../resume/rows.ts";
import { shortClaim } from "../run/present.ts";
import { pickSessionOnScreen, type PickAnswer } from "../resume/screen.ts";
import type { ResumeRow } from "../resume/rows.ts";
import { attendedExitCode, defaultAttendedDeps, prepareAttended, type AttendedDeps } from "./as.ts";
import { noConfigMessage, UNREADABLE_CONFIG_MESSAGE } from "./run.ts";

/** What a resume needs from outside itself, wherever it was asked for. */
export interface ResumeSessionDeps extends AttendedDeps {
  inFlight: InFlightStore;
  /** Whether a pid is a live process. */
  isAlive: (pid: number) => boolean;
  /** This process, which becomes the resumed session's owner. */
  pid: number;
  now: () => Date;
  /** Hands the terminal to the session and answers how it ended. */
  startSession: (request: AttachedRequest) => Promise<AttachedEnding>;
}

/** What the command needs on top: the configuration, and the list. */
export interface ResumeDeps extends ResumeSessionDeps {
  loadConfiguration: typeof loadConfig;
  /** Whether a person is at the terminal, and so whether a list can be asked. */
  isTTY: boolean;
  pick: (rows: ResumeRow[], now: number) => Promise<PickAnswer>;
}

/**
 * The edges as this process has them.
 *
 * **A function rather than a constant**, because this module and `run.ts` import
 * each other through `as.ts`: a constant here would read `as.ts`'s defaults
 * while that module is still being evaluated, whichever of the two loaded first.
 */
export function resumeSessionDefaults(): ResumeSessionDeps {
  return {
    ...defaultAttendedDeps,
    inFlight: diskInFlight,
    isAlive: processAlive,
    pid: process.pid,
    now: () => new Date(),
    startSession: (request) => runAttached(request),
  };
}

/** One session to resume: whose it is, and which. */
export interface ResumeTarget {
  /** The configured name, which the caller read off a record or its own event — never off anything typed. */
  agent: string;
  entry: AgentEntry;
  claim: string;
  workspace: string;
  brain: string | null;
  /**
   * The directory the session ran in, which is where its transcript is.
   *
   * Claude Code files a transcript under the directory it was started in, so a
   * resume started anywhere else finds no conversation — and an entry's `cwd`
   * may have been changed since the session ran.
   */
  cwd: string;
}

/** A resume that has passed every check, waiting for the terminal to be free. */
export interface PreparedResume {
  /** Hands the terminal over and answers the exit code once the person is done. */
  start(): Promise<number>;
  /** Gives up a resume that will not be started after all, letting its lock go. */
  cancel(): Promise<void>;
}

/**
 * Every check a resume makes, and the spawn it will make, without touching the
 * terminal yet.
 *
 * **Split from the start so the caller can free the terminal in between.** The
 * `run` view is still drawn while these run, so a refusal is a note on it; only a
 * resume that will actually happen unmounts the view.
 *
 * **The claim's lock is taken first and held until the session ends**, so two
 * windows choosing one session cannot both pass the running check in the
 * seconds the preflight takes. A caller that is handed a resume must either
 * start it or cancel it.
 *
 * @param err where each refusal's one sentence goes
 * @returns the resume, ready to start, or null once a refusal has been said
 */
export async function prepareResume(deps: ResumeSessionDeps, target: ResumeTarget, err: (line: string) => void): Promise<PreparedResume | null> {
  const { agent, entry, claim } = target;

  let holder: number | null;
  try {
    holder = await deps.inFlight.lock(claim, deps.pid, deps.isAlive);
  } catch (cause) {
    err(`${agent}'s session is not resumed: its lock could not be taken: ${(cause as Error).message}`);
    return null;
  }
  if (holder !== null) {
    err(beingResumedMessage(claim, holder));
    return null;
  }
  const unlock = async () => {
    try {
      await deps.inFlight.unlock(claim);
    } catch {
      // A lock left behind names this process, and is taken over once it is gone.
    }
  };
  const refuse = async (line: string): Promise<null> => {
    err(line);
    await unlock();
    return null;
  };

  // **This process is never the session it is about to resume.** A resume this
  // same process started and that ended badly is over, because this process is
  // here asking.
  const others = (pid: number) => pid !== deps.pid && deps.isAlive(pid);
  let earlier: InFlightRecord | undefined;
  try {
    earlier = (await deps.inFlight.list()).find((record) => record.claim === claim);
  } catch (cause) {
    // Without the list the running check has nothing to read, and two writers
    // of one transcript is the failure it exists to prevent.
    return refuse(`The in-flight records could not be read, so ${agent}'s session is not resumed: ${(cause as Error).message}`);
  }
  if (earlier !== undefined) {
    const pid = runningPid(earlier, others);
    if (pid !== null) return refuse(stillRunningMessage(claim, pid));
  }

  const lines: string[] = [];
  const ready = await prepareAttended(deps, agent, entry, (line) => lines.push(line));
  if (ready === null) return refuse(lines.join("\n"));

  // After `as`'s own checks, so an entry whose checkout is gone is refused in
  // `as`'s words; this is the case they cannot see, a session that ran in a
  // directory the entry no longer names.
  if (!deps.directoryExists(target.cwd)) {
    return refuse(`${shortClaim(claim)} ran in ${target.cwd}, which is gone, and its conversation is filed under that directory.`);
  }

  const spawnable = ready.spec.buildInteractive({
    session: { kind: "resume", id: claim },
    agent,
    mcpConfigPath: mcpConfigPath(agent),
    cwd: target.cwd,
    harnessCredential: ready.harnessCredential,
    connectionKeyVariable: entry.env.connectionKey,
    connectionKey: ready.connectionKey,
    parentEnv: deps.env,
  });

  const record = (over: Partial<InFlightRecord>): InFlightRecord => ({
    claim,
    agentEntryId: entry.id,
    agent,
    workspace: target.workspace,
    brain: target.brain,
    cwd: target.cwd,
    startedAt,
    ownerPid: deps.pid,
    harnessPid: null,
    resumes: (earlier?.resumes ?? 0) + 1,
    // Carried through a resume, so a record a failed resume keeps still says how
    // the run it came from ended.
    ended: earlier?.ended ?? null,
    endedAt: earlier?.endedAt ?? null,
    ...over,
  });
  const write = async (value: InFlightRecord) => {
    try {
      await deps.inFlight.write(value);
    } catch (cause) {
      // A note, never a reason not to resume: only the session's recoverability
      // is lost, and the person is here.
      err(`The in-flight record could not be written: ${(cause as Error).message}`);
    }
  };
  let startedAt = "";

  return {
    cancel: unlock,
    async start() {
      try {
        // Written before the spawn rather than after it, so a resume whose own
        // process dies mid-session leaves the record a person finds it by.
        startedAt = deps.now().toISOString();
        await write(record({}));
        let written: Promise<void> = Promise.resolve();
        // Nothing is printed before the harness takes the terminal, as for `as`.
        const ending = await deps.startSession({
          spawnable,
          cwd: target.cwd,
          onSpawned: (harnessPid) => {
            if (harnessPid === undefined) return;
            // The lock names the harness too, so a lock this process leaves by
            // being killed is stale once the harness is gone, even after the
            // system hands this process's pid to something else.
            const named = deps.inFlight.nameHarness(claim, harnessPid).catch(() => {});
            written = Promise.all([write(record({ harnessPid })), named]).then(() => {});
          },
        });
        await written;
        const code = attendedExitCode(ending, ready.spec, spawnable, err);
        if (code === 0) {
          try {
            await deps.inFlight.remove(claim);
          } catch (cause) {
            err(`The in-flight record could not be removed: ${(cause as Error).message}`);
          }
          return 0;
        }
        // Kept, so a resume that dies is itself resumable, and owned by nothing,
        // because nothing is running it now. Said, because the person will meet
        // the record again in the list.
        await write(record({ ownerPid: null, harnessPid: null }));
        if (ending.spawnProblem === null) err(unfinishedMessage(claim));
        return code;
      } finally {
        await unlock();
      }
    },
  };
}

/**
 * The command, with its dependencies handed in.
 *
 * @returns the child's exit code once a session has started, 0 for an empty
 * list, and 1 for every refusal and for leaving without choosing
 */
export async function runResume(deps: ResumeDeps, context: CommandContext): Promise<number> {
  const { out, err } = context;

  const loaded = await deps.loadConfiguration();
  if (loaded.kind === "none") {
    err(noConfigMessage(configPath()));
    return 1;
  }
  if (loaded.kind === "unreadable") {
    err(UNREADABLE_CONFIG_MESSAGE);
    return 1;
  }
  if (loaded.kind === "problem") {
    err(loaded.message);
    return 1;
  }
  const config: Config = loaded.config;
  const others = (pid: number) => pid !== deps.pid && deps.isAlive(pid);

  // Drawn again after every dismissal, so the list is always what is on disk
  // rather than what was on disk when the command started.
  for (;;) {
    let rows: ResumeRow[];
    try {
      rows = resumeRows(await deps.inFlight.list(), config, others);
    } catch (cause) {
      err(`The in-flight records could not be read: ${(cause as Error).message}`);
      return 1;
    }
    if (rows.length === 0) {
      out(NOTHING_TO_RESUME);
      return 0;
    }

    const now = deps.now().getTime();
    if (!deps.isTTY) {
      const width = nameWidth(rows);
      for (const row of rows) out(rowText(row, now, width));
      err(NO_TERMINAL_MESSAGE);
      return 1;
    }

    const answer = await deps.pick(rows, now);
    // Nothing is said about leaving, as for `as`'s own list.
    if (answer === null) return 1;
    const row = rows.find((candidate) => candidate.record.claim === answer.claim);
    if (row === undefined) return 1;

    if (answer.kind === "dismiss") {
      // **Under the claim's lock, read at the moment of the dismissal**, so a
      // session another window began resuming while this list sat open is not
      // dismissed from under it. A row that only *looks* running is dismissed
      // after the screen's warning: running is read off a pid, and a pid the
      // system has reused would otherwise pin a dead session here for good.
      const claim = row.record.claim;
      let holder: number | null;
      try {
        holder = await deps.inFlight.lock(claim, deps.pid, deps.isAlive);
      } catch (cause) {
        err(`The in-flight record could not be dismissed: ${(cause as Error).message}`);
        return 1;
      }
      if (holder !== null) {
        err(beingResumedMessage(claim, holder));
        return 1;
      }
      try {
        await deps.inFlight.remove(claim);
      } catch (cause) {
        err(`The in-flight record could not be removed: ${(cause as Error).message}`);
        return 1;
      } finally {
        await deps.inFlight.unlock(claim).catch(() => {});
      }
      continue;
    }

    if (row.state.kind !== "resumable" || row.agent === null) return 1;
    const entry = config.agents[row.agent];
    const prepared = await prepareResume(
      deps,
      { agent: row.agent, entry, claim: row.record.claim, workspace: row.record.workspace, brain: row.record.brain, cwd: row.record.cwd },
      err,
    );
    if (prepared === null) return 1;
    return prepared.start();
  }
}

/** `mdbrain resume`, as the registry declares it. */
export const resume: CommandSpec = {
  name: "resume",
  summary: "pick up a run session that ended abruptly, with you driving it",
  run(context) {
    return runResume(
      {
        ...resumeSessionDefaults(),
        loadConfiguration: loadConfig,
        // Both streams, as `as` asks it: the list reads keys from one and draws
        // on the other.
        isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
        pick: (rows, now) => pickSessionOnScreen(rows, now),
      },
      context,
    );
  },
};
