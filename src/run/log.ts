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
// here has: `logRow` can be asserted without a disk.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir, type PathEnv } from "../config/paths.ts";
import type { Outcome } from "./outcome.ts";
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
  exitCode: number | null;
}

/**
 * One finished session as a row.
 *
 * The envelope travels with the instruction — `kind`, `seq`, `at` — because a
 * row that said only *this agent ran* could not be matched to the wake that
 * caused it, which is the first question anybody asks of this file.
 */
export function logRow(unit: WorkUnit, outcome: Outcome, startedAt: Date, endedAt: Date): RunRow {
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
    costUsd: outcome.costUsd,
    turns: outcome.turns,
    exitCode: outcome.exitCode,
  };
}

/** The line a row is written as: one object, one newline, appended. */
export function rowText(row: RunRow): string {
  return `${JSON.stringify(row)}\n`;
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
