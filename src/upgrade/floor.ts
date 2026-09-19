// The server's version floor, as this program meets it: what it names itself
// with, and what it does with a refusal.
//
// Pure, and its own module rather than more of `notice.ts`, because the two are
// different events about the same subject. The notice is something a long-lived
// run mentions and carries on; this decides whether a run starts at all.
//
// **The sentence about what is wrong is the server's, and this may not
// paraphrase it.** Only the server knows the floor, so only the server can name
// the two numbers; only this program knows how it was installed, so only this
// program can say what to run. Neither half guesses at the other's, and the
// verdict is taken from the **status** — never by matching the server's words,
// which would make a wording change into a behaviour change.

import { howToUpgrade, RUNNING_RUN_NOTICE, type Channel } from "./plan.ts";
import { serverWords } from "../run/diagnosis.ts";

/**
 * The header this program names its version in.
 *
 * The same name the server reads, spelled here because the two apps share no
 * code by design. It is a request header rather than a field in a body: a body
 * is parsed by something with opinions about what a work request is, and a
 * version arriving beside them would eventually become a reason to loosen those
 * opinions.
 */
export const RUNNER_VERSION_HEADER = "x-mdbrain-version";

/** What a refusal for being too old arrives as, told apart by status alone. */
export const TOO_OLD_STATUS = 426;

/**
 * How long the startup question is given before it is abandoned.
 *
 * **A bound is needed because `fetch`'s own is minutes**, and this question is
 * asked in front of everything else the command does: a host that accepts a
 * connection and never answers would hold a runner at a blank terminal for as
 * long as it liked. Abandoning the wait is the same as never having asked, which
 * is a start — so the bound costs nothing and buys the property that an
 * unreachable server delays a run by seconds rather than by minutes.
 */
export const STARTUP_ASK_TIMEOUT_MS = 10_000;

/**
 * What this program tells the server about itself: the version, and nothing
 * else.
 *
 * **The omissions are the decision.** This program knows its channel, its target
 * and the engine it runs on precisely, and computes all three once per run
 * already. Sending them would answer questions nobody in this product can answer
 * today — which is exactly why they are not here: the shape of the fleet is a
 * separate decision with a privacy dimension, and a compatibility gate is the
 * wrong vehicle to carry it in.
 */
export function versionHeader(version: string): Record<string, string> {
  return { [RUNNER_VERSION_HEADER]: version };
}

/** What asking the server whether this build may start came back as. */
export type StartupAnswer =
  /** The server answered: its status, its own words, and what it made of this build. */
  | { kind: "answered"; status: number; said: string; minimum: string | null; sent: string | null }
  /** The question could not be put — unreachable, timed out, or answered by an error. */
  | { kind: "unasked"; detail: string };

/** Whether this run starts, and what to say when it does not. */
export type StartupVerdict =
  | { kind: "start" }
  | {
      kind: "too-old";
      /** The whole sentence to print: what is wrong, what to do, and the caveat. */
      message: string;
      /** The server's own words, kept apart so a record holds them unmixed. */
      said: string;
      /** The floor the server named, or null when its answer did not carry one. */
      minimum: string | null;
      /**
       * The version the server says it received, or null when it received none.
       *
       * Taken from the answer rather than re-derived from this build, because the
       * case worth recording is the one where they disagree: a header removed in
       * transit refuses a runner that is perfectly new, and only the server's own
       * account of what arrived can say so.
       */
      sent: string | null;
    };

/** What is said when a refusal arrives with no words in it — not a paraphrase of any. */
const NO_WORDS = "This mdbrain is too old for the server.";

/**
 * The refusal as a person reads it: the server's sentence, the remedy, and the
 * caveat.
 *
 * **The remedy is composed rather than written out.** `howToUpgrade` already
 * knows the right command for an install a package manager owns and the right
 * sentence for a source checkout; a hardcoded `mdbrain upgrade` here would tell
 * the first packaged install to exist to run a command that refuses it.
 *
 * **The caveat is not decoration.** Without it the remedy creates a loop in
 * which following the advice changes nothing: the person upgrades in a second
 * shell, the runner they are watching is still the old image, still refused,
 * still printing the same sentence — and a remedy that visibly failed is worse
 * than one never given.
 *
 * **The server's words are normalised before they are shown**, by the same
 * function the written row uses. What answers a request is not always the
 * application — a proxy or an error page answers too, and what it echoes can
 * carry the request's own bearer token and run to a page of it.
 *
 * @param said the server's own sentence, or empty when it sent none
 * @param channel how this binary arrived
 * @param isCompiled whether there is an installed binary at all
 */
export function tooOldText(said: string, channel: Channel, isCompiled: boolean): string {
  const words = serverWords(said);
  const wrong = words === "" ? NO_WORDS : words;
  return `${wrong} ${howToUpgrade(channel, isCompiled)} ${RUNNING_RUN_NOTICE}`;
}

/**
 * What to do about the server's answer.
 *
 * **A gate that could not be reached must not stop a runner.** A refusal is a
 * verdict the server gave; silence is not one, and a runner that would not start
 * because a request timed out turns an outage into a fleet-wide stop. So
 * anything other than the refusal status starts the run — including a 500, a
 * redirect, a route that is not there yet, and a network that is down.
 *
 * @param answer what came back, or the fact that nothing did
 * @param channel how this binary arrived
 * @param isCompiled whether there is an installed binary at all
 */
export function startupVerdict(answer: StartupAnswer, channel: Channel, isCompiled: boolean): StartupVerdict {
  if (answer.kind === "unasked") return { kind: "start" };
  if (answer.status !== TOO_OLD_STATUS) return { kind: "start" };
  return {
    kind: "too-old",
    message: tooOldText(answer.said, channel, isCompiled),
    said: answer.said,
    minimum: answer.minimum,
    sent: answer.sent,
  };
}
