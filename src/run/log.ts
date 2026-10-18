// The run log: one line of JSON per session, appended under the state root.
//
// **State rather than config**, because it names sessions that happened on this
// machine and it grows — the config root is the thing people copy, and a copied
// history of somebody else's runs is noise at best.
//
// **This is the only completion record in this phase.** The claim id is on every
// row so that completion *can* one day be reported against it on the server; that
// report is not built, and this file is what stands in for it until it is.
//
// The row is built purely and appended impurely, which is the split every module
// here has: `logRow` can be asserted without a disk. It is read back once, at a
// run's start, for the recent runs its view opens with, and `parseRunLog` is the
// pure half of that too.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir, type PathEnv } from "../config/paths.ts";
import { OUTCOME_KINDS, type Outcome, type OutcomeKind } from "./outcome.ts";
import type { ModelTokens } from "./transcript.ts";
import type { WorkUnit } from "../work/instruction.ts";

/** Where the run log lives. */
export function runLogPath(env?: PathEnv): string {
  return join(stateDir(env), "runs.jsonl");
}

/** What one finished session is recorded as. */
export interface RunRow {
  claim: string;
  agent: string;
  workspace: string;
  kind: string;
  seq: number;
  at: string;
  startedAt: string;
  endedAt: string;
  outcome: Outcome["kind"];
  message: string;
  /** The harness's own id for the session, which is not the claim it was given. */
  harnessSessionId: string | null;
  /** The harness's estimate, recorded as the estimate it is. */
  costUsd: number | null;
  turns: number | null;
  /**
   * Where `costUsd` came from. `harness` is the figure the harness reported.
   * `transcript` is recovered from the session's own transcript because the
   * harness reported none, which happens when a session is cut short. It is a
   * floor rather than the same figure: subagents' final output counts and the
   * harness's own side calls are not in the transcript. Null when neither said.
   */
  costSource: CountSource;
  /** Where `turns` came from, on the same terms as `costSource`. */
  turnsSource: CountSource;
  /**
   * The tokens a recovered cost was priced from, per model, on rows whose
   * cost came from the transcript only. Kept so a row priced by a stale table,
   * or not priced because its model was unknown, can be priced again after the
   * transcript itself is gone.
   */
  usage?: Record<string, ModelTokens>;
  exitCode: number | null;
  /**
   * Which signal ended the session, when one did. It answers *did the harness
   * go quietly*, which is what separates a row whose files are probably
   * consistent from one whose files probably are not.
   */
  signal: Outcome["signal"];
}

/** Who said a count: the harness's own result, or the session's transcript. */
export type CountSource = "harness" | "transcript" | null;

/** What a session's transcript said it spent, when its harness said nothing. */
export interface RecoveredUsage {
  costUsd: number | null;
  turns: number | null;
  byModel: Record<string, ModelTokens>;
}

/**
 * One finished session as a row.
 *
 * The envelope travels with the instruction — `kind`, `seq`, `at` — because a
 * row that said only *this agent ran* could not be matched to the wake that
 * caused it, which is the first question anybody asks of this file.
 *
 * `recovered` fills only what the harness left empty. A reported figure is
 * never replaced: it is the one the harness enforced its budget with.
 */
export function logRow(unit: WorkUnit, outcome: Outcome, startedAt: Date, endedAt: Date, recovered: RecoveredUsage | null = null): RunRow {
  const recoveredCost = outcome.costUsd === null ? (recovered?.costUsd ?? null) : null;
  const recoveredTurns = outcome.turns === null ? (recovered?.turns ?? null) : null;
  return {
    claim: unit.instruction.claim,
    agent: unit.instruction.agent,
    workspace: unit.instruction.workspace,
    kind: unit.kind,
    seq: unit.seq,
    at: unit.at,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    outcome: outcome.kind,
    message: outcome.message,
    harnessSessionId: outcome.sessionId,
    costUsd: outcome.costUsd ?? recoveredCost,
    turns: outcome.turns ?? recoveredTurns,
    costSource: outcome.costUsd !== null ? "harness" : recoveredCost !== null ? "transcript" : null,
    turnsSource: outcome.turns !== null ? "harness" : recoveredTurns !== null ? "transcript" : null,
    ...(outcome.costUsd === null && recovered !== null && Object.keys(recovered.byModel).length > 0 ? { usage: recovered.byModel } : {}),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
  };
}

/** The line a row is written as: one object, one newline, appended. */
export function rowText(row: RunRow): string {
  return `${JSON.stringify(row)}\n`;
}

/** The part of a logged row a new run's view opens with. */
export type LoggedRun = Pick<RunRow, "claim" | "agent" | "outcome" | "startedAt" | "endedAt" | "message" | "costUsd">;

/**
 * The run log's text read back into the rows a view can draw, oldest first.
 *
 * **A line that does not read as one is skipped, not reported.** The restored
 * list is a courtesy, and a log one bad line away from refusing it would make
 * the run's first screen depend on the oldest write anybody ever made. Only the
 * fields the view draws are checked, and only those are kept.
 */
export function parseRunLog(text: string): LoggedRun[] {
  const rows: LoggedRun[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof v !== "object" || v === null) continue;
    const { claim, agent, outcome, startedAt, endedAt, message, costUsd } = v;
    if (typeof claim !== "string" || claim === "" || typeof agent !== "string" || agent === "") continue;
    if (!(OUTCOME_KINDS as readonly unknown[]).includes(outcome) || typeof message !== "string") continue;
    if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) continue;
    if (typeof endedAt !== "string" || Number.isNaN(Date.parse(endedAt))) continue;
    if (!(costUsd === null || (typeof costUsd === "number" && Number.isFinite(costUsd)))) continue;
    rows.push({ claim, agent, outcome: outcome as OutcomeKind, startedAt, endedAt, message, costUsd });
  }
  return rows;
}

/**
 * The run log's text, or nothing when there is no log yet.
 *
 * Read whole: a machine's log after six weeks is a few hundred rows, and
 * trimming it is a decision nobody has made.
 */
export async function readRunLog(env?: PathEnv): Promise<string> {
  try {
    return await readFile(runLogPath(env), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw cause;
  }
}

/**
 * Append one row, creating the state directory on the first session.
 *
 * A failure to write is the caller's to report and never the reason a session is
 * called a failure: the work happened, and losing the record of it is a smaller
 * problem than reporting an outcome that did not occur.
 */
export async function appendRun(row: RunRow, env?: PathEnv): Promise<void> {
  const path = runLogPath(env);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, rowText(row), "utf8");
}
