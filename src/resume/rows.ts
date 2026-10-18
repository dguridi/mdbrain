// What `mdbrain resume` lists, and every sentence it says — pure.
//
// The picker draws rows and the command acts on one; everything that could be
// wrong about *which* sessions are offered and *as whom* is decided here, with
// no disk, no clock and no process, so it can be asserted as a table.
//
// **The agent comes off the record and never off anything typed.** A record
// names the config entry id it was written for, and the row resolves that id
// against the configuration this machine holds now. That is the identity wall
// held by construction: a transcript carries everything its agent read, private
// folder included, so the only agent a row can ever resume as is the one whose
// session it was. A record whose entry is gone is drawn and cannot be chosen.

import type { Config } from "../config/schema.ts";
import { runningPid, type InFlightRecord } from "../run/inflight.ts";
import type { OutcomeKind } from "../run/outcome.ts";
// The run view's own renderings, so a claim and an age read the same in both lists.
import { agoText, shortClaim } from "../run/present.ts";

/** Whether a row can be resumed, and if not, why. */
export type RowState =
  | { kind: "resumable" }
  | { kind: "running"; pid: number }
  /** The entry the record was written for is no longer in this configuration. */
  | { kind: "unconfigured" };

/** One session the picker draws. */
export interface ResumeRow {
  record: InFlightRecord;
  /** The configured name the record's entry id resolves to, or null when none does. */
  agent: string | null;
  state: RowState;
}

/** The line drawn under the list, because the resumed session cannot say it in time. */
export const HAZARD_LINE = "A resumed session does not know whether its last action ran. Check before it repeats one.";

/** What an empty list says. */
export const NOTHING_TO_RESUME = "No session on this machine started and never ended, so there is nothing to resume.";

/**
 * What a list nobody can choose from ends with.
 *
 * There is no command to print per row, because no command takes an id: an id
 * typed by somebody is exactly what the identity wall is kept from depending on.
 */
export const NO_TERMINAL_MESSAGE = "Run `mdbrain resume` at a terminal to pick one of these up.";

/**
 * Every record as a row, newest first.
 *
 * @param isAlive whether a pid is a live process; the caller leaves its own pid
 *   out, because a process asking to resume is not the session it would resume
 */
export function resumeRows(records: readonly InFlightRecord[], config: Config, isAlive: (pid: number) => boolean): ResumeRow[] {
  const byEntryId = new Map(Object.entries(config.agents).map(([name, entry]) => [entry.id, name]));
  return [...records]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.claim.localeCompare(b.claim))
    .map((record) => {
      const agent = byEntryId.get(record.agentEntryId) ?? null;
      const pid = runningPid(record, isAlive);
      const state: RowState = pid !== null ? { kind: "running", pid } : agent === null ? { kind: "unconfigured" } : { kind: "resumable" };
      return { record, agent, state };
    });
}

/**
 * How a kept record's ending reads: in a picker row before its age, and in the
 * start-up note after the session's name. Null for an outcome whose record is
 * never kept. One table, so the two sentences cannot come to name an ending
 * differently, and a new outcome is a type error here rather than a silent
 * *never ended*.
 */
const ENDINGS: Record<OutcomeKind, { row: string; note: string } | null> = {
  stopped: { row: "stopped", note: "was stopped with the runner" },
  failed: { row: "failed", note: "failed" },
  "timed-out": { row: "timed out", note: "timed out" },
  killed: { row: "killed", note: "was killed" },
  unreadable: { row: "unreadable", note: "ended with a result that could not be read" },
  done: null,
  "spawn-failed": null,
};

/**
 * A record's ending as the two lists say it, or null when it should read as
 * *never ended*: no ending was written, or a person resumed it since and the
 * resume is the newer fact.
 */
function endingOf(record: InFlightRecord): { row: string; note: string } | null {
  if (record.resumes > 0 || record.ended === null || record.endedAt === null) return null;
  return ENDINGS[record.ended];
}

/**
 * What a row's state says, in the column after the claim.
 *
 * **A record that says how its session ended says that**, aged from the ending.
 * One with no ending was left by a runner that died, and *never ended* is the
 * truth about it. A record a person has resumed says so first, because the
 * resume is the newer fact and it is the one that did not end.
 */
export function stateText(row: ResumeRow, now: number): string {
  switch (row.state.kind) {
    case "running":
      return `still running (process ${row.state.pid})`;
    case "unconfigured":
      return `${row.record.agent} is no longer configured here`;
    case "resumable": {
      const { record } = row;
      if (record.resumes > 0) return `resumed ${agoText(now - Date.parse(record.startedAt))}, never ended`;
      const ending = endingOf(record);
      if (ending === null || record.endedAt === null) return `started ${agoText(now - Date.parse(record.startedAt))}, never ended`;
      const ago = agoText(now - Date.parse(record.endedAt));
      return record.ended === "stopped" ? `${ending.row} ${ago}, when the runner stopped` : `${ending.row} ${ago}`;
    }
  }
}

/**
 * One row as text, with the name column padded to the widest name in the list.
 *
 * The same text the screen draws and the no-terminal path prints, so a session
 * reads the same whichever way it was listed.
 */
export function rowText(row: ResumeRow, now: number, width: number): string {
  const name = (row.agent ?? row.record.agent).padEnd(width);
  const brain = row.record.brain === null ? "" : `    ${row.record.brain}`;
  return `${name}   claim ${shortClaim(row.record.claim)}   ${stateText(row, now)}${brain}`;
}

/** The width {@link rowText} pads names to. */
export function nameWidth(rows: readonly ResumeRow[]): number {
  return Math.max(1, ...rows.map((row) => (row.agent ?? row.record.agent).length));
}

/**
 * The refusal for a session another `mdbrain` is resuming or dismissing right now.
 *
 * @param pid the holder, or 0 for a lock still being written, which names nobody yet
 */
export function beingResumedMessage(claim: string, pid: number): string {
  return `${shortClaim(claim)} is being picked up by another mdbrain${pid > 0 ? ` (process ${pid})` : ""}.`;
}

/** The refusal for a session something is still running. */
export function stillRunningMessage(claim: string, pid: number): string {
  return `${shortClaim(claim)} is still running (process ${pid}).`;
}

/**
 * What a resume that did not exit cleanly ends with.
 *
 * Said because the record was kept, and a kept record is one the person will meet
 * again in the list — including when Claude Code has already deleted the
 * transcript, which is the case `x` is for.
 */
export function unfinishedMessage(claim: string): string {
  return `${shortClaim(claim)} is still recorded as unfinished. \`mdbrain resume\` lists it, and x there dismisses it if it cannot be picked up again.`;
}

/**
 * What a runner says about the sessions it can pick up, or null when there are
 * none: the ones a crash left behind, and the ones kept after an ending that cut
 * them short.
 *
 * One note and not one per session, because the live view keeps a single note
 * and a second would silently replace the first. It names the command and stops
 * there: a runner that resumed what it found would be an unattended resume, and
 * every resume is one a person asked for.
 */
export function leftBehindNote(records: readonly InFlightRecord[], isAlive: (pid: number) => boolean): string | null {
  const ended = records.filter((record) => runningPid(record, isAlive) === null);
  if (ended.length === 0) return null;
  if (ended.length === 1) {
    const [only] = ended;
    const how = endingOf(only)?.note ?? (only.resumes > 0 ? "was resumed and never ended" : "started and never ended");
    return `${only.agent}'s session ${shortClaim(only.claim)} ${how}. \`mdbrain resume\` can pick it up.`;
  }
  const names = [...new Set(ended.map((record) => record.agent))].join(", ");
  const kept = ended.filter((record) => endingOf(record) !== null).length;
  const how = kept === 0 ? "started and never ended" : kept === ended.length ? "were cut short" : "were cut short or never ended";
  return `${ended.length} sessions ${how} (${names}). \`mdbrain resume\` can pick them up.`;
}
