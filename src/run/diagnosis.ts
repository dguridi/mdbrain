// What `run` writes down so a failure can be explained after the screen is gone.
//
// **This module records; it decides nothing.** Nothing here changes which agents
// are asked, whether a claim is made, or when the loop stops — a row is appended
// beside a decision that was already taken. That separation is the whole of why
// it is safe to add: a diagnosis that could alter an outcome would be a second,
// quieter copy of the loop's rules.
//
// It exists because three facts the runner already knows survive nowhere. The
// startup summary names the key store it opened and then scrolls away; a session
// the server refused is printed once, on the way out; and which runtime the
// process is — which is what *decides* the key store — is never said at all. A
// runner that stops overnight therefore leaves a run log full of sessions that
// succeeded and no trace of the one thing that went wrong.
//
// **`runs.jsonl` was the wrong home for this and is deliberately left alone.**
// That file is one row per finished session and is read as such; a start row
// mixed into it would be a row with no claim, no outcome and no duration for
// every reader of it to special-case. This is a second file, in the same state
// root, with the same shape: one JSON object per line, appended.
//
// The rows are built purely and appended impurely, which is the split every
// module here has: a row can be asserted without a disk.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir, type PathEnv } from "../config/paths.ts";

/** Where the diagnosis log lives, beside the run log and under the same root. */
export function diagnosisPath(env?: PathEnv): string {
  return join(stateDir(env), "diagnosis.jsonl");
}

/** Which of the two polled calls was refused. The pair is the whole vocabulary. */
export type RefusedCall = "count" | "claim";

/** How each call is named to a person, so a screen and a row agree about it. */
const CALL_NAMES: Record<RefusedCall, string> = {
  count: "asking how much work is waiting",
  claim: "claiming work",
};

/** The longest server sentence worth carrying; past this it is a page, not a reason. */
export const SAID_LIMIT = 300;

/**
 * Anything credential-shaped, replaced by a marker.
 *
 * **Applied to the server's words before they are printed or written down**, and
 * the reason is that those words are not this program's. A refusal body is
 * whatever answered — the app's own route, but also a proxy, a gateway, or an
 * error page that echoed the request — and the request carried a bearer token.
 *
 * **What it cannot catch, stated rather than implied:** a GoTrue refresh token is
 * opaque and looks like any other short random string, so no pattern separates
 * one from an ordinary word. This covers the shapes that *are* recognisable —
 * JWTs, the connection keys this product mints, the publishable and secret keys
 * of the API, and the token half of an echoed `Authorization` header — and the
 * length cap is what bounds the rest.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bsmd_agent_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]");
}

/**
 * What a refused poll says, on top of the sentence about signing in again.
 *
 * **The suffix is the entire point of this function.** Both polled calls are
 * authorised the same way and both answer the same refusal, so the two failures
 * are indistinguishable on screen — a person looking at `Your session is no
 * longer accepted` cannot tell whether the runner was refused while asking how
 * much work is waiting or while claiming it, and those are different faults with
 * different remedies. The status is carried because a 401 and a 429 are not the
 * same event, and the server's own words because a fixed sentence from this
 * repository and a gateway's error page look identical without them.
 *
 * @param sentence the wording already chosen for the person, which stays first
 * @param call which of the two polled calls was refused
 * @param status the HTTP status the server answered with
 * @param detail the server's own words, which this function redacts and bounds
 */
export function refusedMessage(sentence: string, call: RefusedCall, status: number, detail: string): string {
  const words = serverWords(detail);
  const suffix = words === "" ? "" : `; the server said: ${words}`;
  return `${sentence} (refused while ${CALL_NAMES[call]} — HTTP ${status}${suffix})`;
}

/**
 * The server's words, made safe to carry: redacted, flattened, and bounded.
 *
 * **Flattened before it is bounded**, and that is not tidiness. `readError` hands
 * back the response body verbatim when it is not JSON, so an intercepting proxy's
 * HTML error page arrives with its newlines in it — and this text is spliced into
 * a single stderr sentence and into a JSON-lines file whose whole contract is one
 * record per line. Trimming the ends does nothing about the middle.
 *
 * The one function both the printed line and the written row go through, so the
 * screen and the file can never hold different versions of the same refusal.
 */
function serverWords(detail: string): string {
  return redactSecrets(detail).replace(/\s+/g, " ").trim().slice(0, SAID_LIMIT).trim();
}

/** What the runtime is, which is what decides the key store and is never otherwise said. */
export interface RuntimeFacts {
  /** `bun` or `node` — the difference that relocates every credential the tool holds. */
  engine: string;
  /** The engine's version, so an upgrade that changed behaviour is visible. */
  engineVersion: string;
  /** The binary that is running, which says whether this was the installed executable. */
  execPath: string;
  platform: string;
}

/**
 * The running process, read once.
 *
 * Impure and separate from {@link startRow} so a test can state a runtime rather
 * than inherit the one it happens to run under.
 */
export function runtimeFacts(): RuntimeFacts {
  const bun = (globalThis as { Bun?: { version?: string } }).Bun;
  return {
    engine: bun ? "bun" : "node",
    engineVersion: bun?.version ?? process.versions.node,
    execPath: process.execPath,
    platform: `${process.platform}-${process.arch}`,
  };
}

/** One `run` starting: everything that was true before the first poll. */
export interface StartRow {
  kind: "start";
  at: string;
  /** The build, so a row can be matched to the code that wrote it. */
  version: string;
  channel: string;
  compiled: boolean;
  runtime: RuntimeFacts;
  /** Which store was opened, and where it puts things. The line that scrolls away. */
  keyStore: string;
  keyStoreWhere: string;
  configPath: string;
  asking: string[];
  held: Array<{ agent: string; reason: string }>;
  /** The configured agents this run never asks for, because they poll for nothing. */
  attended: string[];
  pollMs: number;
}

/** One poll refused by the server: the record the screen's single line does not leave. */
export interface RefusedRow {
  kind: "refused";
  at: string;
  call: RefusedCall;
  status: number;
  /** The server's own words, redacted and capped exactly as the printed line is. */
  said: string;
}

/** One `run` ending, and why — the fact no file has ever held. */
export interface StopRow {
  kind: "stop";
  at: string;
  /** `session-ended`, `signal`, `once`, `all-held`, `none-polling`, or `finished`. */
  reason: string;
  exitCode: number;
  /** How many sessions ran, so a row of stops reads as a history rather than a list. */
  sessions: number;
}

export type DiagnosisRow = StartRow | RefusedRow | StopRow;

/** What a starting `run` is recorded as. */
export function startRow(at: Date, facts: Omit<StartRow, "kind" | "at">): StartRow {
  return { kind: "start", at: at.toISOString(), ...facts };
}

/**
 * What a refused poll is recorded as.
 *
 * @param detail the **server's** own words, not the sentence shown to the person
 *   — the row's whole value is holding what this program did not write.
 */
export function refusedRow(at: Date, call: RefusedCall, status: number, detail: string): RefusedRow {
  return { kind: "refused", at: at.toISOString(), call, status, said: serverWords(detail) };
}

/** What a stopping `run` is recorded as. */
export function stopRow(at: Date, reason: string, exitCode: number, sessions: number): StopRow {
  return { kind: "stop", at: at.toISOString(), reason, exitCode, sessions };
}

/** The line a row is written as: one object, one newline, appended. */
export function diagnosisText(row: DiagnosisRow): string {
  return `${JSON.stringify(row)}\n`;
}

/**
 * Append one row, creating the state directory on the first run.
 *
 * A failure to write is the caller's to report and is never a reason to refuse to
 * run: this file explains a failure, and a runner that would not start because it
 * could not open its own notebook has turned a diagnostic into an outage.
 */
export async function appendDiagnosis(row: DiagnosisRow, env?: PathEnv): Promise<void> {
  const path = diagnosisPath(env);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, diagnosisText(row), "utf8");
}
