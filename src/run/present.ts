// The events `run` emits, and the presenter that prints them as plain lines.
//
// **The event types are the contract two presenters share**, not this file's
// private shapes. Everything the runner decides — a poll, a session starting, an
// outcome, an agent held — becomes one typed event here, and a presenter only
// renders it. That is what stops the live view and the plain lines disagreeing
// about what happened, and it is why nothing else in `run` writes to a stream:
// a line printed outside this vocabulary is a fact one presenter has and the
// other does not.
//
// **Two words that used to be one.** A `held` agent is held for the life of the
// process — a credential variable unset, a directory gone, a name the roster does
// not hold — and a `skipped` agent is one this tick did not ask for because a
// session of its own is already running. They were both called *held*, which is
// how a roster comes to draw the wrong one: a tick-level skip is not a state an
// agent sits in.
//
// **An event is not a line.** Every line is an event, but the reverse stopped
// being true once a second presenter wanted facts a log file has no use for: a
// countdown means nothing in a file nobody is watching. So a presenter may
// render an event as nothing, and `plainLine` answers null for the events whose
// only reader is the screen. That keeps the vocabulary one thing while leaving
// each existing line's shape, ordering and stream exactly what they were.
//
// **And it runs the other way too**, which is what `day` is: a plain line is
// stamped with a time of day and no date, so a log read back is ambiguous about
// which day `12:04:01` was — while the screen, whose recent runs say their own
// age, has nothing to draw for it. An event with one reader is the shape this
// vocabulary already had; `day` is the first one whose reader is the log.
//
// **A presenter may also be asked something**, which is the one direction that
// used to be closed. A key is not a decision: it produces a `ViewRequest`, which
// is a sentence about what the person wants, handed to the runner's own loop.
// The loop stays the only thing that polls, claims and spawns.
//
// Pure: every event carries the text of its own line, and the presenter is a
// function from an event to a string or to nothing. The clock is the caller's.

import type { OutcomeKind } from "./outcome.ts";
import type { ViewRequest } from "./keys.ts";
import { connectionText, listeningText, type ConnectionState, type ListeningState } from "./channel.ts";
import { versionNoticeText } from "../upgrade/notice.ts";
import { VERSION } from "../version.ts";

/**
 * What `run` calls itself at the top of both surfaces.
 *
 * **The product and the build, rather than the command.** Whoever is reading
 * this line typed the command a moment ago; what they cannot see anywhere else
 * is which `mdbrain` answered — and this is a program that replaces its own
 * binary, is left running for days across an upgrade, and can be refused by the
 * server for being too old. The number is `version.ts`'s, the same constant
 * `--version` prints, so the banner cannot come to disagree with the build
 * behind it.
 *
 * It sits with the events because both presenters draw it — the live view's
 * title and the first line of the plain summary are this one string — and two
 * literals a few modules apart is exactly how one surface comes to name a
 * version the other does not.
 */
export const RUN_TITLE = `markdownbrain.ai agent runner v${VERSION}`;

/**
 * Where the runner is, between one poll and the next.
 *
 * **`waiting` carries the moment the next poll is due rather than how long is
 * left**, which is what lets a countdown be drawn without the runner's state
 * moving on a clock: the deadline arrives as an event and only the subtraction
 * is the screen's.
 *
 * **`finishing` is the state that was missing**, and it covers three things that
 * look identical from outside: `--once` waiting out the sessions its single tick
 * started, a signed-in session the server has ended, and a stop in progress. In
 * all three the loop will not poll again and may still have minutes of work
 * outstanding, so a countdown drawn then counts down to nothing and a poll asked
 * for then can never happen.
 */
export type RunPhase = { kind: "polling" } | { kind: "waiting"; at: number } | { kind: "finishing" };

/** Every event `run` can emit. A presenter renders these and nothing else. */
export type RunEvent =
  /** Startup: this agent will be asked for work. One per configured agent. */
  | { kind: "configured"; agent: string }
  /** Startup: this agent will never be asked, for the life of the process. */
  | { kind: "held"; agent: string; reason: string }
  /** Startup: the summary printed before the first poll. */
  | { kind: "summary"; lines: string[] }
  /** A tick asked the server. `waiting` is null when the count was not reached. */
  | { kind: "poll"; agents: string[]; waiting: number | null }
  /** This tick did not ask for this agent, because one of its sessions is running. */
  | { kind: "skipped"; agent: string; reason: string }
  /** The server held work back under a ceiling; `reason` is its own sentence. */
  | { kind: "refused"; agent: string; reason: string }
  /** A unit is waiting behind one that is running. `depth` is the queue after it. */
  | { kind: "queued"; agent: string; depth: number }
  /**
   * A session started. It carries the file and the brain's name as well as the
   * brain's id, because **the two presenters want different halves of that**: a
   * log line is correlated against the database later, where the id is the only
   * thing that joins, and a screen is read now, where a name is. Each takes what
   * its own reader needs and neither invents the other.
   *
   * `file` is the path the trigger fired about, or null when the event names no
   * file — a mention names none even in principle, since mentions coalesce and
   * one wake can stand for five. `brain` is the workspace's name, or null when
   * the runner has none: the names are read alongside the brain list, so a lookup
   * that failed, or a claim from a brain that list did not name, leaves it unknown
   * rather than delaying the session for it.
   *
   * `recordedAt` is when the event this unit came from was **written**, which is
   * not when it was claimed and is the difference this field exists to show. A
   * unit can sit unclaimed for a long time — its agent was busy when it came due,
   * and nothing re-read until something else caused one — and without this the
   * screen draws a stale wake and a fresh one identically. It is the unit's own
   * `at`, carried rather than looked up.
   */
  | {
      kind: "start";
      agent: string;
      claim: string;
      unitKind: string;
      seq: number;
      workspace: string;
      file: string | null;
      brain: string | null;
      recordedAt: string;
    }
  /**
   * A session ended well. `message` is the harness’s own result text, carried but
   * **not printed by the plain presenter**: it can be paragraphs, the plain
   * lines are a log a person greps, and `runs.jsonl` holds the whole of it
   * beside them. The live view is what the field is for.
   */
  | { kind: "done"; agent: string; claim: string; ms: number; costUsd: number | null; turns: number | null; message: string }
  | { kind: "failed"; agent: string; claim: string; outcome: OutcomeKind; ms: number; message: string }
  /** Where the runner is between polls. The screen draws it; no line prints it. */
  | { kind: "phase"; phase: RunPhase }
  /**
   * The local date the events after it happened on. The log prints it; the
   * screen draws nothing for it.
   *
   * **The mirror image of `phase`, and it is here for the same reason that one
   * renders as nothing.** A plain line is stamped with a time of day and no
   * date, which is enough while somebody is watching and ambiguous the moment
   * they read the file back — `12:04:01` is a different fact on a runner that
   * has been up for three days. The screen has no use for it, because a recent
   * run there says its own age.
   *
   * Carries the text rather than the moment, so both presenters would say the
   * same words and the runner is the one that chose them.
   */
  | { kind: "day"; date: string }
  /** A person asked for a poll. `reason` is why it was not taken, or null. */
  | { kind: "asked"; taken: boolean; reason: string | null }
  /** Something worth one line that is not about a particular agent. */
  | { kind: "note"; message: string }
  /**
   * A newer version of `mdbrain` is published.
   *
   * **Its own kind rather than a `note`, and that is the whole of its design.**
   * In the live view `note` is a single slot — the reducer assigns the last one
   * and the screen draws whatever is in it — and there are six senders of `note`
   * in `run.ts` alone: a renamed agent, a run log that could not be written, a
   * count that could not be read, a failed claim, an unreadable instruction, and
   * work for an agent this runner does not run. **A version notice sent as a
   * `note` is erased by the first of those to fire**, and on a runner left up for
   * days that is a near certainty rather than a risk. So it occupies a field no
   * `note` sender can reach, because it is not in that slot at all.
   *
   * The alternative considered and not taken was making `note` a list, which is a
   * larger change to a contract two presenters share and to the screen's layout.
   *
   * Carries the fact and the remedy rather than the sentence, so the wording
   * lives in one pure function both presenters call.
   */
  | { kind: "version"; version: string; how: string }
  /**
   * Where the presence connection stands.
   *
   * **The connection's state and nothing about presence itself**, which is a
   * split rather than a matter of taste: the runner reports what it did, and the
   * app reports what is. Whether an agent shows in a roster is the browser's to
   * say, and a terminal claiming it would be a second answer to a question that
   * already has one.
   *
   * Sent only when the state changes, so a socket retrying against a network
   * that is down is one line rather than a narration of every attempt. Carries
   * the state rather than the sentence, so both presenters say the same words
   * and one pure function chose them.
   */
  | { kind: "connection"; state: ConnectionState }
  /**
   * Where the socket that listens for work stands.
   *
   * **Its own event rather than a widening of presence's**, because the two
   * sockets mean different things to the person reading. Presence being down
   * costs a dot in somebody else's browser and nothing here; this being down is
   * the difference between work starting within seconds of landing and work
   * starting at the end of a poll interval — which is three quarters of an
   * hour, fixed, and not a range anybody can shorten.
   *
   * **It exists because every way this fails is otherwise silent.** A brain list
   * that could not be read, a join refused, a room taken back by an expired
   * token: each leaves a runner that is polling and looks exactly like a runner
   * in a brain where nothing is happening. Carries the counts as well as the
   * state so *some of them* can be said, and sent only when the aggregate
   * changes.
   */
  | { kind: "listening"; state: ListeningState; held: number; total: number }
  /** The last thing said: what stopping cost. */
  | { kind: "stopped"; lostQueued: number };

/** An event with the moment it happened, which is what a line is stamped with. */
export interface StampedEvent {
  at: Date;
  event: RunEvent;
}

/** The label column's width, so every line's text starts in the same place. */
const LABEL_WIDTH = 10;

/** `12:04:01`, local time — the stamp a person reads beside a shell's own output. */
export function clockText(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `Mon 8 Sep 2026`, local — the date a person reads rather than parses.
 *
 * Written out rather than taken from `Intl`, for the reason every other string
 * here is: the runner's output is one language, and a locale-derived date would
 * make the log's shape depend on the machine it ran on. An ISO date would be
 * unambiguous and is the thing the ask named as not wanted — somebody at a
 * terminal is asking *ten minutes ago or yesterday*, not reading a field.
 */
export function dayText(at: Date): string {
  return `${DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

/**
 * The date to announce before an event stamped `at`, or null when the day has
 * already been said.
 *
 * **A null `previous` announces**, so the first line of any run carries its
 * date and a log file is anchored from its first byte rather than from whenever
 * the runner happens to cross midnight.
 *
 * Compared on the local calendar day and not on elapsed hours: two events
 * fourteen minutes apart across midnight are two dates, and two events twenty
 * hours apart on one long day are one.
 *
 * @param previous the stamp of the last event announced against, or null
 * @param at the stamp of the event about to be rendered
 * @returns the date's text, or null when it is the same day
 */
export function dayLine(previous: Date | null, at: Date): string | null {
  if (
    previous !== null &&
    previous.getFullYear() === at.getFullYear() &&
    previous.getMonth() === at.getMonth() &&
    previous.getDate() === at.getDate()
  ) {
    return null;
  }
  return dayText(at);
}

/**
 * How long ago something was, in the terms the question is asked in.
 *
 * **One unit, and it is not `durationText`.** That one measures a session, where
 * the seconds are the thing being reported and two units earn their place. This
 * one answers *ten minutes ago or yesterday*, and at every scale the second unit
 * is noise a reader has to look past: `20h00m ago` says nothing `20h ago` does
 * not, and the four characters it costs are four a person's eye has to cross on
 * every row.
 *
 * @param ms how long ago, in milliseconds; a negative value reads as `just now`
 *   rather than as the future, since a clock that disagrees with itself by a
 *   moment is likelier than a run that has not happened yet
 */
export function agoText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * A duration a person reads rather than counts: `7m38s`, `41s`, `1h02m`.
 *
 * Two units at most and never a bare number of milliseconds, for the same reason
 * the config refuses one: a number with no unit is the value two readers can
 * disagree about while both look right.
 */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * What the harness said a session cost, or `—` when it said nothing.
 *
 * The dash is deliberate: a run whose cost is unknown and a run that cost
 * nothing are different facts, and `$0.00` would report the second for the
 * first. The figure is the harness's own estimate and is never added up here.
 */
export function costText(costUsd: number | null): string {
  return costUsd === null ? "—" : `$${costUsd.toFixed(2)}`;
}

/** A claim id shortened for a line, since only its first bytes are ever read by eye. */
export function shortClaim(claim: string): string {
  return claim.length <= 8 ? claim : `${claim.slice(0, 4)}…`;
}

/**
 * One event as one plain line, or null when it has no line.
 *
 * The refusal and skip sentences are printed as they stand rather than
 * rephrased, so the server, `agentsToAsk` and this log agree word for word. That
 * is why those events carry a `reason` rather than the values to build one from.
 *
 * **Null is for an event whose only reader is a screen.** `phase` is the one: a
 * countdown redrawn every second is the opposite of what a log file wants, and
 * the poll it counts to prints its own line when it happens.
 */
export function plainLine(stamped: StampedEvent): string | null {
  const { at, event } = stamped;
  const line = (label: string, text: string) => `${clockText(at)} ${label.padEnd(LABEL_WIDTH)}${text}`;
  switch (event.kind) {
    case "configured":
      return line("asking", event.agent);
    case "held":
      return line("held", `${event.agent}: ${event.reason}`);
    case "summary":
      return event.lines.join("\n");
    case "poll":
      return line(
        "poll",
        `asked for ${event.agents.join(", ")}${event.waiting === null ? "" : ` — ${event.waiting} waiting`}`,
      );
    case "skipped":
      return line("skipped", event.reason);
    case "refused":
      return line("refused", event.reason);
    case "queued":
      return line("queued", `${event.agent}  ${event.depth} waiting`);
    case "start":
      // The workspace id stays and the path is added beside it. The id is what a
      // row read back out of the database joins on; the path is what tells two
      // otherwise identical lines apart when somebody is reading the file rather
      // than querying it.
      return line(
        "start",
        `${event.agent}  claim ${shortClaim(event.claim)}  ${event.unitKind} #${event.seq}  ${event.workspace}${event.file === null ? "" : `  ${event.file}`}`,
      );
    case "done":
      return line(
        "done",
        `${event.agent}  claim ${shortClaim(event.claim)}  ${durationText(event.ms)}  ${costText(event.costUsd)}  turns ${event.turns ?? "—"}`,
      );
    case "failed":
      return line("failed", `${event.agent}  claim ${shortClaim(event.claim)}  ${event.outcome}: ${event.message}`);
    case "phase":
      // Nothing. A countdown is a screen's business, and the line for a poll is
      // the `poll` event, when it happens.
      return null;
    case "day":
      return line("day", event.date);
    case "asked":
      return line(
        "asked",
        event.taken ? "a poll was asked for, and taken" : `a poll was asked for and not taken: ${event.reason ?? "no reason given"}`,
      );
    case "note":
      return line("note", event.message);
    case "version":
      return line("version", versionNoticeText({ version: event.version, how: event.how }));
    case "connection":
      return line("presence", connectionText(event.state));
    case "listening":
      return line("listening", listeningText(event.state, event.held, event.total));
    case "stopped":
      return line(
        "stopped",
        event.lostQueued === 0
          ? "nothing was queued"
          : `${event.lostQueued} queued ${event.lostQueued === 1 ? "unit" : "units"} lost`,
      );
  }
}

/** A presenter: something that is handed every event and draws it however it draws. */
export interface Presenter {
  present(event: RunEvent, at?: Date): void;
  /**
   * Register what the person can ask for.
   *
   * The one channel that runs the other way, and it carries a request rather
   * than an action: a presenter with a keyboard forwards what was pressed, and
   * the handler — which lives in the loop — decides what to do about it. A
   * presenter with no keyboard never calls it, which is why the plain one can
   * implement this by doing nothing at all.
   */
  listen(handler: (request: ViewRequest) => void): void;
  /** Let the presenter finish — the plain one has nothing to do. */
  stop(): Promise<void>;
}

/**
 * The presenter for anything that is not a terminal.
 *
 * A service manager, a log file and a scheduler read this, so its shape is
 * stable on purpose and the live view may not change it.
 */
export function plainPresenter(out: (line: string) => void, now: () => Date = () => new Date()): Presenter {
  return {
    present(event, at) {
      const text = plainLine({ at: at ?? now(), event });
      if (text !== null) out(text);
    },
    listen() {
      // Nothing behind a service manager is pressing keys, and a presenter that
      // pretended otherwise would be inventing a person.
    },
    stop() {
      return Promise.resolve();
    },
  };
}
