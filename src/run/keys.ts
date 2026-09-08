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
// cursor through the recent runs changes what is drawn and nothing about what the
// runner is doing. Keeping the two apart in the table is what stops the second
// kind quietly becoming the first.
//
// **Ctrl-C is in this table for a reason that is easy to miss.** Reading keys at
// all puts the terminal in raw mode, and a terminal in raw mode no longer turns
// Ctrl-C into a signal — so the moment the view accepts a keypress, the
// interrupt stops arriving as one and the view has to hand it back. It is bound
// to the same request the quit key is, which reaches the same handler the signal
// would have.

/** What a person can ask the runner for. Two things, and both are asks. */
export type ViewRequest = "poll-now" | "quit";

/** What a person can ask the screen for. None of these reach the runner. */
export type ScreenAction = "older" | "newer" | "clear";

/** Where a key goes, and what it says when it gets there. */
export type KeyAction = { to: "loop"; request: ViewRequest } | { to: "screen"; action: ScreenAction };

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
    summary: "pick a recent run",
    matches: (_input, key) => key.upArrow,
  },
  {
    action: { to: "screen", action: "older" },
    label: "↓",
    summary: "pick a recent run",
    matches: (_input, key) => key.downArrow,
  },
  {
    action: { to: "screen", action: "clear" },
    label: "esc",
    summary: "close the run",
    matches: (_input, key) => key.escape,
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

/** What a keypress does, or null when it asks for nothing this view offers. */
export function actionForKey(input: string, key: KeyModifiers): KeyAction | null {
  for (const binding of KEY_BINDINGS) {
    if (binding.matches(input, key)) return binding.action;
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
export function keyHints(): string[] {
  const order: string[] = [];
  const labels = new Map<string, string[]>();
  for (const binding of KEY_BINDINGS) {
    if (!labels.has(binding.summary)) {
      order.push(binding.summary);
      labels.set(binding.summary, []);
    }
    labels.get(binding.summary)!.push(binding.label);
  }
  return order.map((summary) => `${labels.get(summary)!.join(" or ")} — ${summary}`);
}
