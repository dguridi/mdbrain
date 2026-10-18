// The keys the live view accepts, as one table.
//
// **One place says which key does what**, and both the matcher and the line of
// help drawn on screen read it — so the view cannot offer a key it does not
// accept, or accept one it never named. That is the whole reason this is a table
// rather than a chain of comparisons inside the component, and it is why the
// hint text is derived rather than written out a second time.
//
// **A key goes to one of two places, and the table says which.** Two of them ask
// the *runner* for something — poll now, stop — and those are requests: a
// sentence about what the person wants, handed to the loop, which stays the only
// thing that polls, claims and spawns. The rest are the *screen's* own: moving a
// cursor through the sessions changes what is drawn and nothing about what the
// runner is doing. Keeping the two apart in the table is what stops the second
// kind quietly becoming the first.
//
// **Ctrl-C is in this table for a reason that is easy to miss.** Reading keys at
// all puts the terminal in raw mode, and a terminal in raw mode no longer turns
// Ctrl-C into a signal — so the moment the view accepts a keypress, the
// interrupt stops arriving as one and the view has to hand it back. It is bound
// to the same request the quit key is, which reaches the same handler the signal
// would have.
//
// **`r` is a request that carries its run, and it is offered only for a run it
// can act on.** It asks the loop to resume the selected run's session, so it
// names which run — the selection is the screen's, and the loop has no other way
// to know it. A binding can say when it is offered, and the hint line and the
// matcher both ask, so a key that does nothing for this run is neither drawn nor
// taken.
//
// **`k` kills one running session, and it does not kill anything itself.** It
// is offered only on a running session that is not already ending, and pressing
// it opens a question on the screen. The answer to that question is read by the
// screen and never through this table: a `y` matched here would also be read as
// whatever the table binds `y` to, and an `esc` meant as *no* would also clear
// the cursor. Only the `y` sends a request, and the loop decides what to do
// with it.

import type { PickedSession } from "./view.ts";

/**
 * Picking up a finished run's session again, with the person driving it.
 *
 * The agent and claim travel with the request because the loop decides nothing
 * from the screen's state: what it resumes is exactly what was on the row.
 */
export interface ResumeRequest {
  kind: "resume";
  agent: string;
  claim: string;
}

/**
 * Ending one running session, after the person confirmed it.
 *
 * **A name and never a handle.** The agent and claim are what the row said; the
 * loop looks the claim up in its own registry and checks the agent is still
 * running it, so a request that arrives after the session ended — or that names
 * a session the loop does not hold — is refused out loud rather than acted on.
 */
export interface KillRequest {
  kind: "kill";
  agent: string;
  claim: string;
}

/** What a person can ask the runner for. Every one of them is an ask. */
export type ViewRequest = "poll-now" | "quit" | ResumeRequest | KillRequest;

/** What a person can ask the screen for. None of these reach the runner. */
export type ScreenAction = "older" | "newer" | "clear";

/**
 * Where a key goes, and what it says when it gets there.
 *
 * `resume` goes to the loop as well, but only once the screen has added the run
 * the cursor is on, which is why it is its own destination rather than a
 * request with nothing in it. `kill` stops at the screen first: it opens the
 * confirmation, and only the screen's own reading of a `y` sends the request.
 */
export type KeyAction =
  | { to: "loop"; request: "poll-now" | "quit" }
  | { to: "resume" }
  | { to: "kill" }
  | { to: "screen"; action: ScreenAction };

/** The parts of Ink's `Key` this module reads. Narrowed so a test needs no Ink. */
export interface KeyModifiers {
  ctrl: boolean;
  upArrow: boolean;
  downArrow: boolean;
  escape: boolean;
}

/** One key: what matches it, what it is called, and what pressing it is for. */
export interface KeyBinding {
  action: KeyAction;
  /** What the hint line calls this key. */
  label: string;
  /**
   * What pressing it is for, in the fewest words that are still true. Keys that
   * share a summary are offered together, which is how the two ways of stopping
   * read as one offer rather than as two competing ones.
   */
  summary: string;
  matches: (input: string, key: KeyModifiers) => boolean;
  /**
   * Whether the key does anything with this session picked, or absent for a key
   * that always does. A key that is not offered is neither named nor matched.
   */
  offered?: (selected: PickedSession | null) => boolean;
}

/**
 * The keymap.
 *
 * A table from the first key rather than a chain of conditions, because the
 * question *is this one key or the start of a keymap* was answered as the
 * second — and answered by events rather than by argument: a want for a second
 * key arrived before the first had shipped. A table makes the next one a row.
 *
 * The letters are deliberately unmodified and deliberately not `c`: the view is
 * not a field being typed into, so a bare letter costs nothing, and the one
 * letter that would collide with the interrupt is left alone.
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  {
    action: { to: "loop", request: "poll-now" },
    label: "p",
    summary: "poll now",
    matches: (input, key) => input === "p" && !key.ctrl,
  },
  {
    action: { to: "screen", action: "newer" },
    label: "↑",
    summary: "pick a session",
    matches: (_input, key) => key.upArrow,
  },
  {
    action: { to: "screen", action: "older" },
    label: "↓",
    summary: "pick a session",
    matches: (_input, key) => key.downArrow,
  },
  {
    action: { to: "screen", action: "clear" },
    label: "esc",
    summary: "close the run",
    matches: (_input, key) => key.escape,
  },
  {
    action: { to: "resume" },
    label: "r",
    summary: "resume this run",
    matches: (input, key) => input === "r" && !key.ctrl,
    // Only where a harness ran and was cut short, and a resume has something to
    // go from: a run that finished has nothing to pick up, one that never
    // spawned has no transcript, and a restored run whose record is gone has
    // nothing to resume it as.
    offered: (selected) => selected !== null && selected.kind === "recent" && selected.run.resumable,
  },
  {
    action: { to: "kill" },
    label: "k",
    summary: "kill this session",
    matches: (input, key) => input === "k" && !key.ctrl,
    // Only on a session that is running and not already being ended: a run that
    // finished has nothing to kill, and a second kill of one session would be a
    // key that looks like it did something and did not.
    offered: (selected) => selected !== null && selected.kind === "running" && !selected.ending,
  },
  {
    action: { to: "loop", request: "quit" },
    label: "q",
    summary: "stop",
    matches: (input, key) => input === "q" && !key.ctrl,
  },
  {
    action: { to: "loop", request: "quit" },
    label: "ctrl-c",
    summary: "stop",
    matches: (input, key) => input === "c" && key.ctrl,
  },
];

/** Whether a binding does anything with this session picked. */
function isOffered(binding: KeyBinding, selected: PickedSession | null): boolean {
  return binding.offered === undefined || binding.offered(selected);
}

/**
 * What a keypress does, or null when it asks for nothing this view offers.
 *
 * @param selected the session the cursor is on, which decides whether `r` and
 *   `k` are keys
 */
export function actionForKey(input: string, key: KeyModifiers, selected: PickedSession | null = null): KeyAction | null {
  for (const binding of KEY_BINDINGS) {
    if (isOffered(binding, selected) && binding.matches(input, key)) return binding.action;
  }
  return null;
}

/**
 * The keys named for the screen, one phrase per thing they do.
 *
 * Grouped by what a key is *for* rather than by the key itself, so the arrows
 * read as one offer and so do the two ways of stopping. Derived from the table
 * above, which is what stops the screen naming a key that does nothing.
 */
export function keyHints(selected: PickedSession | null = null): string[] {
  const order: string[] = [];
  const labels = new Map<string, string[]>();
  for (const binding of KEY_BINDINGS) {
    if (!isOffered(binding, selected)) continue;
    if (!labels.has(binding.summary)) {
      order.push(binding.summary);
      labels.set(binding.summary, []);
    }
    labels.get(binding.summary)!.push(binding.label);
  }
  return order.map((summary) => `${labels.get(summary)!.join(" or ")} — ${summary}`);
}
