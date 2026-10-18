// The keys the `mdbrain agents` browser accepts, as one table.
//
// The pattern is `run/keys.ts`'s, for its reason: the matcher and the hint line
// both read this table, so the screen cannot offer a key it does not accept or
// accept one it never named.
//
// **Only two keys write anything, `r` and `d`, and both ask first.** Everything
// else moves the cursor, asks the server again, or leaves — `e` included, which
// edits nothing itself: it leaves for `configure`'s menu, opened at the agent,
// so the file keeps exactly one editor of settings. That is what keeps
// opening the browser free of risk: a person can look at every agent on the
// machine and press nothing but arrows without a single file, key or server row
// changing.
//
// **Ctrl-C is bound for the reason it is bound in `run`**: reading keys puts the
// terminal in raw mode, where Ctrl-C stops arriving as a signal, so a browser
// that did not bind it could not be left the way every other program is left.

/** What a key asks the browser for. */
export type BrowserAction = "up" | "down" | "check" | "edit" | "renew" | "remove" | "quit";

/** The parts of Ink's `Key` this module reads. Narrowed so a test needs no Ink. */
export interface BrowserKey {
  ctrl: boolean;
  upArrow: boolean;
  downArrow: boolean;
  escape: boolean;
}

/** One key: what matches it, what the hint calls it, and what it is for. */
export interface BrowserBinding {
  action: BrowserAction;
  label: string;
  summary: string;
  matches: (input: string, key: BrowserKey) => boolean;
}

export const BROWSER_BINDINGS: readonly BrowserBinding[] = [
  { action: "up", label: "↑", summary: "pick an agent", matches: (_input, key) => key.upArrow },
  { action: "down", label: "↓", summary: "pick an agent", matches: (_input, key) => key.downArrow },
  { action: "check", label: "c", summary: "check again", matches: (input, key) => input === "c" && !key.ctrl },
  { action: "edit", label: "e", summary: "change its settings", matches: (input, key) => input === "e" && !key.ctrl },
  { action: "renew", label: "r", summary: "renew its key", matches: (input, key) => input === "r" && !key.ctrl },
  { action: "remove", label: "d", summary: "delete its configuration", matches: (input, key) => input === "d" && !key.ctrl },
  { action: "quit", label: "q", summary: "leave", matches: (input, key) => input === "q" && !key.ctrl },
  { action: "quit", label: "esc", summary: "leave", matches: (_input, key) => key.escape },
  { action: "quit", label: "ctrl-c", summary: "leave", matches: (input, key) => input === "c" && key.ctrl },
];

/**
 * What a keypress asks for, or null when it asks for nothing this browser offers.
 *
 * @param offered whether an action is offered for the picked agent right now. A
 *   key that is not offered is not matched either, so the hint line and the
 *   matcher cannot disagree about it.
 */
export function browserActionFor(input: string, key: BrowserKey, offered: (action: BrowserAction) => boolean = () => true): BrowserAction | null {
  return BROWSER_BINDINGS.find((binding) => binding.matches(input, key) && offered(binding.action))?.action ?? null;
}

/** The keys named for the screen, one phrase per thing they do, derived from the table. */
export function browserHints(offered: (action: BrowserAction) => boolean = () => true): string {
  const order: string[] = [];
  const labels = new Map<string, string[]>();
  for (const binding of BROWSER_BINDINGS) {
    if (!offered(binding.action)) continue;
    if (!labels.has(binding.summary)) {
      order.push(binding.summary);
      labels.set(binding.summary, []);
    }
    labels.get(binding.summary)!.push(binding.label);
  }
  return order.map((summary) => `${labels.get(summary)!.join(" ")} ${summary}`).join(" · ");
}
