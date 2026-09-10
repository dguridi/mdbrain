// Reading what a harness session left behind into what happened.
//
// **The result object is the outcome and the exit code is a hint**, which is the
// whole of this module's opinion. A failure inside a run — a missing credential
// above all — is reported by the harness in its own JSON rather than by the
// process dying, so a reader that trusted the code would call an authentication
// failure a success on any version that exits 0 for it.
//
// The shape below is what was observed on Claude Code 2.1.259 rather than what
// the documentation describes, and the difference matters in one place:
// `subtype` reads `"success"` on an authentication failure, so it says nothing
// and is not read. `is_error` and `terminal_reason` are the two fields that do.
//
// Pure: text in, an outcome out. No process, no clock, no disk.

/**
 * Every outcome a session can have, as a value.
 *
 * The list rather than the union alone, because a presenter has to size a column
 * to the longest of them and a number written down beside the two most common
 * ones is wrong about the other four the day it is written. A kind added here
 * widens that column by being declared.
 */
export const OUTCOME_KINDS = ["done", "failed", "timed-out", "stopped", "spawn-failed", "unreadable"] as const;

/** What became of one session. */
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** What happened, and everything worth recording about it. */
export interface Outcome {
  kind: OutcomeKind;
  /** What to print: the harness's own words on a failure, its result on success. */
  message: string;
  /** The harness's own session id, which is not the claim id it was given. */
  sessionId: string | null;
  /** The harness's estimate, recorded as the estimate it is and never summed. */
  costUsd: number | null;
  turns: number | null;
  /** What the harness said it took, which is not what the runner timed. */
  durationMs: number | null;
  exitCode: number | null;
  /** For `timed-out`: whether SIGTERM sufficed, or SIGKILL was needed. */
  signal: "term" | "kill" | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numberOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const textOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * The sentence added when the harness refused a credential.
 *
 * The harness names the failure; this names the variable, because the harness
 * has no idea the value reached it from a configuration file naming one. Nothing
 * else is added to a harness's own words.
 */
export function credentialHint(variable: string | null): string {
  return variable === null
    ? "The harness is configured to use this machine's own signed-in account; check that it is still signed in."
    : `The credential came from ${variable}; check that it is set and current.`;
}

/**
 * The tools a session was refused, off the harness's own record of them.
 *
 * **Read defensively, because the shape of an entry is not pinned down.** What
 * matters is that there was at least one denial and, where the entry says so,
 * which tool it was about; an entry this build cannot read still counts as a
 * denial, since the alternative is to report a blocked session as a success on
 * the strength of not recognising a field.
 *
 * **Counted rather than merely named**, because the two readings a person makes
 * of a refusal are *it took one detour* and *it fought the whole way*, and a
 * list of names cannot tell them apart. One declined call in sixty-three is the
 * ordinary case and reads as noise; twenty is the run's story.
 */
export function deniedTools(value: unknown): { tool: string; count: number }[] {
  if (!Array.isArray(value)) return [];
  const counted: { tool: string; count: number }[] = [];
  for (const entry of value) {
    const name = isRecord(entry) ? (textOrNull(entry.tool_name) ?? textOrNull(entry.tool)) : textOrNull(entry);
    const said = name ?? UNNAMED_TOOL;
    const seen = counted.find((c) => c.tool === said);
    if (seen) seen.count += 1;
    else counted.push({ tool: said, count: 1 });
  }
  return counted;
}

/** What a denial entry is called when the entry itself does not say. */
export const UNNAMED_TOOL = "a tool it did not name";

const nameList = (names: readonly string[]): string =>
  names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Whether a refused tool belongs to a server the runner supplied.
 *
 * The prefix is enough because of `--strict-mcp-config`: the only MCP server a
 * session can see is the one written for it, so every `mcp__` tool in a denial
 * came from this program's own file and its own grant.
 *
 * **A denial this build could not read counts as one of ours**, for the reason
 * {@link deniedTools} reads defensively in the first place: the two answers are
 * loud and quiet, and choosing quiet on the strength of not recognising a field
 * is how a session that did nothing comes to be reported as having worked.
 */
export function isSuppliedTool(name: string): boolean {
  return name.startsWith("mcp__") || name === UNNAMED_TOOL;
}

/**
 * What to say when the session was refused a tool the runner itself supplied.
 *
 * **This one is terminal and it is the runner's own fault**: the workspace
 * server is how a session reads its instruction's subject, does the work and
 * says what it did, so a session refused it has nothing left to be doing. The
 * message says where the fix lives, and that is this program rather than the
 * person's machine — nothing they can change makes it right.
 */
export function permissionRefusedMessage(denied: readonly string[]): string {
  const plural = denied.length === 1 ? "it was refused" : "they were refused";
  return (
    `The session was refused the workspace tools the runner handed it. It needed ${nameList(denied)}, and ${plural} — ` +
    `these come from the MCP file this program writes and the grant it passes with it, so a session refused them ` +
    `cannot read its instruction's subject or report what it did. This is the runner's own configuration, not the machine's.`
  );
}

/**
 * What to say about the harness's own tools a session was refused.
 *
 * **Not a verdict, and it must not read like one.** The session is told nobody
 * can approve anything and carries on, so this is a detour rather than an
 * ending — and it goes *after* the session's own report, because on a run that
 * finished, what the agent says it did is the thing worth reading and a notice
 * above it displaces the answer.
 *
 * **It offers no advice, deliberately.** Two different things arrive in
 * `permission_denials` and the object does not say which: a tool nobody
 * allowed, which a permissions rule would fix, and a single call the classifier
 * declined, which no rule reliably would — auto mode drops blanket `Bash(*)`
 * and wildcarded interpreter rules on entry, so the rule a person would reach
 * for first is the one it ignores. Telling somebody to write a rule when the
 * runner cannot tell which case it is sends them to do work that may do
 * nothing.
 *
 * The counts carry the meaning instead: one declined call is a detour, twenty
 * is a session that spent its budget arguing.
 */
export function toolsRefusedNote(denied: readonly { tool: string; count: number }[]): string {
  const named = denied.map(({ tool, count }) => `${count} ${tool} call${count === 1 ? "" : "s"}`);
  const total = denied.reduce((sum, { count }) => sum + count, 0);
  return `(${nameList(named)} ${total === 1 ? "was" : "were"} declined along the way; the session was told and carried on.)`;
}

/** The sentence for stdout that was not a result object. */
export const UNREADABLE_OUTCOME_MESSAGE =
  "The harness exited cleanly and printed something that was not a result object; nothing can be said about what it did.";

/**
 * The result object off a harness's stdout, or null.
 *
 * The last JSON object in the stream rather than the whole of it: `--output-format
 * json` prints one object, but anything the harness or a wrapper writes before it
 * would otherwise make the whole read fail, and a failure to parse is reported as
 * `unreadable` — a much louder answer than it deserves.
 */
export function resultObject(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    const whole: unknown = JSON.parse(text);
    if (isRecord(whole)) return whole;
  } catch {
    // Not one object; try the last line, which is where a result lands when
    // something has printed ahead of it.
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value: unknown = JSON.parse(lines[i]);
      if (isRecord(value)) return value;
    } catch {
      // Not this line either.
    }
  }
  return null;
}

/** What the runner knows about a session that the harness's own output does not say. */
export interface SessionEnd {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The runner was stopping and ended this session early. */
  stopped: boolean;
  /** Which signal ended the session, when one did. */
  signal: "term" | "kill" | null;
  /** The variable the harness's credential came from, for the 401 sentence. */
  credentialVariable: string | null;
}

/**
 * What became of one session.
 *
 * The order is the design and each branch closes a case the others do not:
 * a wall clock that fired is a timeout whatever the output says; a result object
 * is the answer whether the exit code agrees or not; a clean exit with no result
 * object is loud rather than successful; and a dirty exit with no result object
 * is a failure whose only words are the harness's stderr.
 */
export function readOutcome(end: SessionEnd): Outcome {
  const object = resultObject(end.stdout);
  const base = {
    sessionId: object ? textOrNull(object.session_id) : null,
    costUsd: object ? numberOrNull(object.total_cost_usd) : null,
    turns: object ? numberOrNull(object.num_turns) : null,
    durationMs: object ? numberOrNull(object.duration_ms) : null,
    exitCode: end.exitCode,
    signal: end.signal,
  };

  // A session the runner stopped is neither a failure nor a timeout: the work
  // was not refused and its wall clock had not run out. Its own kind, so a run
  // log read later does not report a Ctrl-C as something the harness did.
  if (end.stopped && !end.timedOut) {
    return {
      ...base,
      kind: "stopped",
      message:
        end.signal === "kill"
          ? "The runner was stopping and this session did not stop when asked, so it was killed."
          : "The runner was stopping, so this session was stopped before it finished.",
    };
  }

  if (end.timedOut) {
    return {
      ...base,
      kind: "timed-out",
      message:
        end.signal === "kill"
          ? "The session passed its wall clock and did not stop when asked, so it was killed."
          : "The session passed its wall clock and was stopped.",
    };
  }

  if (object) {
    // `is_error` and `terminal_reason` are the two fields that say what
    // happened. `subtype` is not read: it says "success" on an authentication
    // failure, which is exactly the case this whole module exists to catch.
    const failed = object.is_error === true;
    const denied = deniedTools(object.permission_denials);

    // **A refusal is split by who is answerable for it, and the two answers are
    // genuinely different.** A tool the runner supplied and granted is this
    // program's own doing and leaves the session with nothing to be doing, so it
    // is a failure however cleanly the harness reported — every field on the
    // object says `success` in that case, which is what makes it worth catching
    // at all. A refusal of one of the harness's own tools is not: the session is
    // told nobody can approve anything and carries on, so it is a fact about the
    // run rather than a verdict on it, and reporting it as a failure would mean
    // reporting most sessions as failures for a command the classifier declined
    // and the agent worked around. A signal that fires on every run says
    // nothing.
    const supplied = denied.filter(({ tool }) => isSuppliedTool(tool));
    const harnessOwn = denied.filter(({ tool }) => !isSuppliedTool(tool));

    if (supplied.length > 0) {
      const alsoFailed = failed
        ? ` The harness also reported a failure: ${textOrNull(object.result) ?? textOrNull(object.terminal_reason) ?? "no reason given"}`
        : "";
      // The verdict is the runner's own grant, but the harness's refusals are
      // still carried: they are the same fact the other two branches report, and
      // a reader asking whether the session got anywhere before it was stopped
      // has nowhere else to learn it.
      const alsoDeclined = harnessOwn.length === 0 ? "" : ` ${toolsRefusedNote(harnessOwn)}`;
      return {
        ...base,
        kind: "failed",
        message: `${permissionRefusedMessage(supplied.map(({ tool }) => tool))}${alsoFailed}${alsoDeclined}`,
      };
    }

    if (!failed) {
      const said = textOrNull(object.result) ?? "";
      if (harnessOwn.length === 0) return { ...base, kind: "done", message: said };
      // The note trails. On a run that finished, the agent's own report is the
      // answer somebody came for, and a notice about a declined call put above
      // it is a notice standing in front of the answer.
      return { ...base, kind: "done", message: said === "" ? toolsRefusedNote(harnessOwn) : `${said}\n\n${toolsRefusedNote(harnessOwn)}` };
    }
    const said = textOrNull(object.result) ?? textOrNull(object.terminal_reason) ?? "the harness reported a failure";
    const unauthorized = object.api_error_status === 401;
    const words = unauthorized ? `${said} ${credentialHint(end.credentialVariable)}` : said;
    return {
      ...base,
      kind: "failed",
      // A refusal beside a failure is worth naming even though it is not the
      // verdict: it is the likeliest explanation of the failure a reader has.
      message: harnessOwn.length === 0 ? words : `${words} ${toolsRefusedNote(harnessOwn)}`,
    };
  }

  if (end.exitCode === 0) {
    return { ...base, kind: "unreadable", message: UNREADABLE_OUTCOME_MESSAGE };
  }

  const said = end.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";
  return {
    ...base,
    kind: "failed",
    message: said === "" ? `The harness exited with code ${end.exitCode ?? "unknown"} and said nothing.` : said,
  };
}
