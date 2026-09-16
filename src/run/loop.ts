// The tick, as a decision rather than as a loop.
//
// Everything `run` chooses between polls lives here and takes values: who to ask,
// where each unit of work goes, and what the startup summary says. The command
// holds the timer, the sockets and the processes; this module holds the reasons,
// which is what lets a tick be tested without any of the three.
//
// **`limit` is 1 and each agent has a queue, and the two are one decision.** The
// claim is terminal — taking a unit is what marks it done — so the runner must
// never take more work than it will run. But the server's limit is per *trigger*
// and per member, so an agent with two triggers is offered two units on one poll
// however small the limit is, and the claim cannot be asked for *one unit for
// this agent*. So the runner takes the smallest it can ask for and queues what
// arrives beyond the first.

import { agentsToAsk, type HeldAgent, type WorkUnit } from "../work/instruction.ts";
import type { Config } from "../config/schema.ts";

/** The `limit` every claim carries, for the reason in this file's header. */
export const CLAIM_LIMIT = 1;

/** An agent this process will never ask for work, and the sentence saying why. */
export interface HeldReason {
  agent: string;
  reason: string;
}

/**
 * Why an agent is held for the life of the process.
 *
 * Held at startup rather than per tick, because none of these three can change
 * without the process being restarted — the environment is read once, and the
 * roster is read once for the reason §5a gives.
 */
export function holdReason(
  agent: string,
  entry: Config["agents"][string],
  env: Record<string, string | undefined>,
  directoryExists: (path: string) => boolean,
  rosterNames: ReadonlySet<string> | null,
): string | null {
  if (entry.env.harness !== null && !env[entry.env.harness]) {
    return `${entry.env.harness} is not set.`;
  }
  if (!directoryExists(entry.cwd)) {
    return `its directory ${entry.cwd} is not there.`;
  }
  if (rosterNames !== null && !rosterNames.has(agent)) {
    return "it is not in the roster this account can see; it is configured here and will receive no work.";
  }
  return null;
}

/** What startup decided about every configured agent. */
export interface Startup {
  asking: string[];
  held: HeldReason[];
  /**
   * The agents configured here that this command never asks for: `pollsWork` is
   * false, so they exist for `mdbrain as` and for nothing this process does.
   *
   * **Kept apart from `held` rather than folded into it**, because the two are
   * different facts with different remedies. A hold is something that went
   * wrong — an unset variable, a directory that moved — and every one of them is
   * a line a person is meant to read and act on. This is a decision somebody
   * already took, and reporting it in the same voice would put a settled answer
   * in the list of problems and teach a reader to skim it.
   */
  attended: string[];
}

/**
 * Which configured agents this process will ask for, and which it will not.
 *
 * Every agent gets an answer, and both halves are reported: an agent missing
 * from a roster of what is running is indistinguishable from one that was never
 * configured, which is the whole reason a hold is a state rather than a silence.
 */
export function planStartup(
  config: Config,
  env: Record<string, string | undefined>,
  directoryExists: (path: string) => boolean,
  rosterNames: ReadonlySet<string> | null,
): Startup {
  const asking: string[] = [];
  const held: HeldReason[] = [];
  const attended: string[] = [];
  for (const [agent, entry] of Object.entries(config.agents)) {
    // Taken before the hold checks rather than after, and that ordering is the
    // decision: every one of those checks asks whether this agent could run
    // *here, now, under this process*, and none of them is this process's
    // business for an agent it will never ask for. An identity-only agent whose
    // harness variable is unset in the shell `run` was started from is not held;
    // it is simply not this command's.
    if (!entry.pollsWork) {
      attended.push(agent);
      continue;
    }
    const reason = holdReason(agent, entry, env, directoryExists, rosterNames);
    if (reason === null) asking.push(agent);
    else held.push({ agent, reason });
  }
  return { asking, held, attended };
}

/** An agent configured here under a name the roster now gives a different id. */
export interface RenamedAgent {
  configuredAs: string;
  nowCalled: string;
  id: string;
}

/**
 * Configured entries whose agent still exists under another name.
 *
 * A rename and a deletion look identical from a list of names, and the remedy is
 * different for each — one is `configure`, the other is a decision about whether
 * the agent should still be here — so the id is what tells them apart.
 */
export function renamedAgents(config: Config, roster: ReadonlyMap<string, string>): RenamedAgent[] {
  const nameById = new Map<string, string>();
  for (const [name, id] of roster) nameById.set(id, name);
  const renamed: RenamedAgent[] = [];
  for (const [configuredAs, entry] of Object.entries(config.agents)) {
    const nowCalled = nameById.get(entry.id);
    if (nowCalled !== undefined && nowCalled !== configuredAs) {
      renamed.push({ configuredAs, nowCalled, id: entry.id });
    }
  }
  return renamed;
}

/**
 * The lines printed before the first poll.
 *
 * **What is left after the block was cut down to what a person acts on.** Every
 * line here answers *nothing is happening because nothing is waiting* against
 * *nothing is happening because I am not running*; a line that only restated
 * something the screen already draws below it, or a number nobody acts on
 * mid-run, made the two lines that do answer it harder to find.
 *
 * So the agents asked for are not named — the live view lists every one of them
 * as idle or working, and the plain log has already printed an `asking` line per
 * agent — and neither the ceiling nor the interval is stated. What stays is a
 * held agent and its reason, which is the one fact nothing else on screen
 * carries, and where the run log is.
 *
 * **The empty branch of the asking line stays, and what it is worth is smaller
 * than it looks.** `planStartup` empties `asking` only when every configured
 * agent is held or every one of them is identity-only, so this line never
 * appears without the lines that explain it, and `run` refuses immediately
 * afterwards with a sentence of its own. It is kept because the block should
 * state its own conclusion rather than leave it to be inferred from a list — not
 * because anything would otherwise go unsaid. **It says which of the two it is**,
 * because the remedies have nothing in common: one is a machine with something
 * wrong on it, the other is a machine that was configured this way on purpose.
 *
 * @param keyStorage where the connection keys are held, or null to say nothing.
 *   The caller decides: it is said on the file fallback and kept back on the
 *   keychain, so the notice lands where it is news.
 */
export function summaryLines(startup: Startup, runLogPath: string, keyStorage: string | null): string[] {
  const lines: string[] = ["mdbrain run"];
  if (startup.asking.length === 0) {
    lines.push(
      startup.held.length === 0
        ? "  Asking for nobody: every agent configured here is identity-only."
        : "  Asking for nobody: every configured agent is held.",
    );
  }
  for (const held of startup.held) lines.push(`  Held: ${held.agent} — ${held.reason}`);
  // One line however many there are, because it carries no reason to read: what
  // a held line is for is telling a person what to fix, and there is nothing
  // here to fix. What it does carry is that the names are configured, so an
  // agent absent from the roster below is absent on purpose.
  if (startup.attended.length > 0) {
    lines.push(`  Identity only, not asked for work: ${startup.attended.join(", ")}.`);
  }
  lines.push(`  Run log: ${runLogPath}`);
  if (keyStorage !== null) lines.push(keyStorage);
  return lines;
}

/** Which agents a tick asks for, and which it skips because one is already running. */
export function tickPlan(asking: readonly string[], running: ReadonlySet<string>): { ask: string[]; skipped: HeldAgent[] } {
  const { ask, held } = agentsToAsk(asking, running);
  return { ask, skipped: held };
}

/** Where one unit goes: started now, or waiting behind one that is. */
export interface Placement {
  unit: WorkUnit;
  action: "start" | "queue";
  /** The queue's depth after this unit was placed on it, for the `queued` event. */
  depth: number;
}

/**
 * Where each unit of an answer goes.
 *
 * Pure, and it is the only thing that decides: the command applies the answer to
 * its own queues rather than deciding for itself, so *one session per agent at a
 * time* is a property that can be tested without a process.
 *
 * @param units the work the claim answered with, in the order it answered
 * @param busy the agents with a session running right now
 * @param depths how many units are already waiting per agent
 */
export function placeWork(
  units: readonly WorkUnit[],
  busy: ReadonlySet<string>,
  depths: ReadonlyMap<string, number>,
): Placement[] {
  const willRun = new Set(busy);
  const queued = new Map(depths);
  const placements: Placement[] = [];
  for (const unit of units) {
    const agent = unit.instruction.agent;
    if (willRun.has(agent)) {
      const depth = (queued.get(agent) ?? 0) + 1;
      queued.set(agent, depth);
      placements.push({ unit, action: "queue", depth });
      continue;
    }
    willRun.add(agent);
    placements.push({ unit, action: "start", depth: 0 });
  }
  return placements;
}

/**
 * How close together two polls a person asked for may be.
 *
 * The counter is a network call, and a key is easy to lean on. This is not a
 * rate limit in the server's sense — it is short enough that a deliberate second
 * press lands, and long enough that a held key cannot become a stream of
 * requests.
 */
export const POLL_NOW_MIN_GAP_MS = 3_000;

/** What the loop does with a poll a person asked for, and the sentence for it. */
export type PollNowAnswer =
  | { kind: "taken"; reason: null }
  | { kind: "in-flight"; reason: string }
  | { kind: "finishing"; reason: string }
  | { kind: "too-soon"; reason: string };

/** Where the loop is when a person asks it for a poll. */
export interface PollNowState {
  /** A tick is in flight right now. */
  polling: boolean;
  /**
   * The loop will not poll again — it is waiting out the sessions it started.
   *
   * **This is the one a refusal most needs and the easiest to forget**, because
   * it is not a moment but a stretch that can run for minutes: `--once` after
   * its single tick, a signed-in session the server has ended, and a stop in
   * progress all sit here. A request taken in this state would be reported as
   * taken and then never happen, which is exactly the dropped-keypress failure
   * saying the refusal out loud exists to prevent.
   */
  finishing: boolean;
  /** When the last asked-for poll was taken, or null for none. */
  lastTakenAt: number | null;
}

/**
 * Whether a poll a person asked for is taken, and why not when it is not.
 *
 * Pure, and it answers in words rather than in a boolean, because the thing a
 * refusal must not look like is a dropped keypress. A person who presses a key
 * and sees nothing concludes the key does not work; one who sees *a poll is
 * already in flight* has learnt what the runner is doing.
 *
 * @param now the moment of the keypress, in epoch milliseconds
 */
export function answerPollNow(now: number, state: PollNowState): PollNowAnswer {
  if (state.finishing) {
    return {
      kind: "finishing",
      reason: "No more polls are coming: this run is finishing the sessions it started.",
    };
  }
  if (state.polling) {
    return { kind: "in-flight", reason: "A poll is already in flight, so this one would ask the same question twice." };
  }
  if (state.lastTakenAt !== null && now - state.lastTakenAt < POLL_NOW_MIN_GAP_MS) {
    return {
      kind: "too-soon",
      reason: `You asked a moment ago; the counter is not asked more than once every ${Math.round(POLL_NOW_MIN_GAP_MS / 1000)}s.`,
    };
  }
  return { kind: "taken", reason: null };
}
