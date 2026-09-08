// What the live view knows, as a pure reducer over the events `run` emits.
//
// The screen that draws this is `run/screen.ts`, and the split is the same one
// `configure` already makes between `questions.ts` and `screen.ts`: everything
// that could be wrong about *what is true* lives in a module with no terminal, no
// clock and no filesystem, and the Ink layer only draws it. That is what makes
// *the view shows nothing an event did not put there* a test rather than a claim.
//
// **It reads nothing and writes nothing beyond the configuration.** No file, no
// state on disk, no call of its own. The recent-runs list is what this process
// has seen since it started, held in memory, and it is gone when the process
// exits — `runs.jsonl` is the durable record and this never reads it back, since
// a view that read the log would be a second reader of the runner's own output
// and the two could disagree.
//
// **What redraws, and on what.** Every value here changes only when an event
// says so; `applyEvent` is the whole of that. Two things on screen move without
// an event: the spinner's frame, and the second hand of the countdown. Both are
// renderings of a value that did arrive as an event — the runner said which
// agents are running and where it is between polls, and the clock only supplies
// the animation and the subtraction. The rule is that the *rendering* may be
// timer-driven and the *runner's state* may not, and anything else moving on a
// timer is a defect.
//
// **What the spinner attests.** `--output-format json` means the harness says
// nothing at all until it is done, so a running session is opaque from outside: a
// spinner says the process is alive and says nothing about progress. It reads as
// *working*, which is why that is written down here and in the spec rather than
// left to be discovered by somebody watching it spin on a stuck session — the
// wall clock is what ends one of those, and the spinner was never watching it.

import type { OutcomeKind } from "./outcome.ts";
import type { RunEvent, RunPhase } from "./present.ts";
import type { ScreenAction } from "./keys.ts";

/** How many finished sessions the view remembers. Memory only, and never read back. */
export const RECENT_LIMIT = 5;

/** One agent, as a row. */
export interface AgentRow {
  agent: string;
  /**
   * `held` is for the life of the process; `idle` and `running` are where an
   * agent that is being asked for work sits. A tick-level skip is not a state:
   * the agent whose session is already running is `running`, which is the same
   * fact said usefully.
   */
  state: "idle" | "running" | "held";
  /** Why it is held, or the last thing said about it. */
  note: string | null;
  /** Units waiting behind the one that is running. */
  queued: number;
}

/** One finished session, as the view remembers it. */
export interface RecentRun {
  agent: string;
  outcome: OutcomeKind;
  ms: number;
  costUsd: number | null;
  /**
   * The harness’s own words: its result on a session that ended well, the
   * failure on one that did not. It is the `message` field of the row written
   * to `runs.jsonl`, carried here on the event rather than read back off the
   * file, which is the boundary this view is not allowed to cross.
   */
  message: string;
  /** The claim, which is the same id the run log’s row is keyed on. */
  claim: string;
}

/**
 * Where the view thinks the runner is.
 *
 * The runner's own three phases, plus `unknown` — which belongs to the view
 * rather than to the runner and means *it has not said yet*. Nothing is drawn
 * for it, because a screen that guessed would be the one thing this reducer
 * exists to prevent.
 */
export type PollPhase = { kind: "unknown" } | RunPhase;

/** Everything on screen. Nothing here is read from anywhere but events. */
export interface ViewState {
  /** In configuration order, which is the order the summary named them in. */
  agents: AgentRow[];
  recent: RecentRun[];
  summary: string[];
  /** The last thing that was not about a particular agent. */
  note: string | null;
  /** How much work the last poll found, when it said. */
  waiting: number | null;
  poll: PollPhase;
}

/** A view that has seen nothing yet. */
export const emptyView: ViewState = {
  agents: [],
  recent: [],
  summary: [],
  note: null,
  waiting: null,
  poll: { kind: "unknown" },
};

function withRow(state: ViewState, agent: string, change: (row: AgentRow) => AgentRow): ViewState {
  let found = false;
  const agents = state.agents.map((row) => {
    if (row.agent !== agent) return row;
    found = true;
    return change(row);
  });
  // An event about an agent the view has not been told about is still drawn:
  // silence about an agent is the one thing this roster exists to prevent.
  if (!found) agents.push(change({ agent, state: "idle", note: null, queued: 0 }));
  return { ...state, agents };
}

/**
 * The view after one event.
 *
 * Pure, and it is the whole of what the screen knows: given the same events the
 * plain presenter is given, this produces the same facts in a different shape.
 * That is what makes "the presenter never decides anything" checkable rather
 * than merely stated.
 */
export function applyEvent(state: ViewState, event: RunEvent): ViewState {
  switch (event.kind) {
    case "configured":
      return withRow(state, event.agent, (row) => ({ ...row, state: "idle", note: null }));
    case "held":
      return withRow(state, event.agent, (row) => ({ ...row, state: "held", note: event.reason }));
    case "summary":
      return { ...state, summary: event.lines };
    case "poll":
      return { ...state, waiting: event.waiting, note: null };
    case "phase":
      return { ...state, poll: event.phase };
    case "asked":
      // A refusal has to be visible or the key looks broken; a request that was
      // taken needs no sentence, because the screen is about to show a poll.
      return { ...state, note: event.taken ? null : event.reason };
    case "skipped":
      // Already `running` by construction, since that is why it was skipped.
      // Nothing to change, and changing anything would be the view inventing a
      // state the runner does not have.
      return state;
    case "refused":
      return withRow(state, event.agent, (row) => ({ ...row, note: event.reason }));
    case "queued":
      return withRow(state, event.agent, (row) => ({ ...row, queued: event.depth }));
    case "start":
      return withRow(state, event.agent, (row) => ({
        ...row,
        state: "running",
        note: `${event.unitKind} #${event.seq} · ${event.workspace}`,
      }));
    case "done": {
      const next = withRow(state, event.agent, (row) => ({
        ...row,
        state: "idle",
        note: null,
        queued: Math.max(0, row.queued - 1),
      }));
      const run: RecentRun = {
        agent: event.agent,
        outcome: "done",
        ms: event.ms,
        costUsd: event.costUsd,
        message: event.message,
        claim: event.claim,
      };
      return { ...next, recent: [run, ...next.recent].slice(0, RECENT_LIMIT) };
    }
    case "failed": {
      const next = withRow(state, event.agent, (row) => ({
        ...row,
        state: "idle",
        note: event.message,
        queued: Math.max(0, row.queued - 1),
      }));
      return {
        ...next,
        recent: [
          { agent: event.agent, outcome: event.outcome, ms: event.ms, costUsd: null, message: event.message, claim: event.claim },
          ...next.recent,
        ].slice(0, RECENT_LIMIT),
      };
    }
    case "note":
      return { ...state, note: event.message };
    case "stopped":
      // The last line is printed after the view is gone, so there is nothing to
      // draw for it. `livePresenter` is where that happens.
      return state;
  }
}

/**
 * Which recent run the person is looking at, **named by its claim** rather than
 * by its position.
 *
 * The list grows from the top: a session that ends pushes everything down one,
 * so an index held across an event silently comes to mean a different run. The
 * claim is the run's own name, is already carried, and is the same id the run
 * log's row is keyed on — so a selection either resolves to the run it was made
 * against or, once that run has fallen off the end of the window, to nothing.
 * Nothing is the honest answer there; a neighbour would be a quiet substitution.
 */
export type Selection = string | null;

/** The run the cursor is on, or null when it is on none or on one that is gone. */
export function selectedRun(recent: readonly RecentRun[], selection: Selection): RecentRun | null {
  if (selection === null) return null;
  return recent.find((run) => run.claim === selection) ?? null;
}

/**
 * The cursor after one key.
 *
 * `older` from nothing lands on the newest run, which is what a person pressing
 * down on a list they are not yet in means. `newer` off the top leaves the list
 * rather than sticking to the first row: the way out of a detail view should not
 * require knowing that a second key exists.
 */
export function moveSelection(recent: readonly RecentRun[], selection: Selection, action: ScreenAction): Selection {
  if (action === "clear" || recent.length === 0) return null;
  const current = recent.findIndex((run) => run.claim === selection);
  if (action === "older") {
    if (current === -1) return recent[0].claim;
    return recent[Math.min(current + 1, recent.length - 1)].claim;
  }
  if (current <= 0) return null;
  return recent[current - 1].claim;
}

/** How much of a harness's own words the detail shows before pointing at the log. */
export const MESSAGE_PREVIEW_LIMIT = 600;

/**
 * A message cut to something a terminal can hold, and whether anything was cut.
 *
 * The harness's result is prose it wrote for a person and can run to paragraphs;
 * this view has a roster and a countdown to draw as well. **Truncation is said
 * out loud** rather than done silently, because a message that stops mid-sentence
 * with no mark is indistinguishable from a harness that stopped mid-sentence.
 */
export function messagePreview(message: string, limit = MESSAGE_PREVIEW_LIMIT): { text: string; truncated: boolean } {
  const text = message.trim();
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit).trimEnd()}…`, truncated: true };
}
