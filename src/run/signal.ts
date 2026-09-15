// When a work signal should turn into a read, as a decision rather than a timer.
//
// The impure half — the socket that receives the signal and the timer that fires
// the read — is `signals.ts` and `commands/run.ts`. What is here is the rule they
// carry out, kept separate for the reason every pure module in this folder is:
// the mistake worth catching is in *when* a burst becomes one read, and a test
// that had to wait out real seconds to see it is a test nobody runs.

/**
 * How long a signal waits before the read it asked for.
 *
 * Long enough that a folder of files dropped at once is one read rather than
 * forty, short enough that the whole point of signalling — work starting in
 * seconds rather than at the end of a poll interval — survives it. It is a few
 * seconds because both of those are true at a few seconds and neither is true at
 * either extreme.
 */
export const SIGNAL_DEBOUNCE_MS = 3_000;

/**
 * The closest together two signal-driven reads may be.
 *
 * **The debounce bounds a burst; this bounds a stream**, and they are different
 * failures. Forty files dropped at once are forty signals inside one window and
 * become one read. An agent working in a watched brain is a signal every few
 * seconds for as long as it works — each one outside the last window, each one
 * arming its own read, none of them finding anything to claim, because the stream
 * that produces the events is the very agent whose own writes the claim excludes.
 * Without a floor, the feature whose stated purpose is to *reduce* call volume on
 * the authentication path would raise it by an order of magnitude exactly when a
 * brain is busiest.
 *
 * **Thirty seconds, and it is now a number of its own.** It was the poll's
 * minimum — the fastest a runner could be configured to ask was the fastest
 * signals could make it ask — and that derivation went when the poll stopped
 * being configurable. The figure is kept rather than recomputed from the fixed
 * interval, because what it bounds is a stream of reads on the authentication
 * path and that has nothing to do with how long the safety net waits.
 *
 * **Two things are held to it, not one.** A work signal is the obvious one; a
 * session ending is the other, and it shares this window deliberately so the two
 * cannot between them make twice the requests this was written to bound.
 */
export const SIGNAL_MIN_GAP_MS = 30_000;

/**
 * The longest a signal may put a read off for.
 *
 * The delay is the server's, and this is the ceiling on trusting it. Nothing the
 * database can currently ask for comes near it — the longest a session waits is
 * its maximum delay — so this is not a limit on the feature, it is a limit on how
 * far a wrong or forged value can move a read. It cannot suppress one either way:
 * the poll runs on its own interval regardless.
 */
export const SIGNAL_MAX_DELAY_MS = 10 * 60_000;

/**
 * How long a signal asks the runner to wait, read off what it carried.
 *
 * **Anything unreadable means read now**, which is deliberately the behaviour a
 * signal had before it carried anything: a server that stops sending the field, a
 * payload of another shape, a negative number, all degrade to the old design
 * rather than to silence. The failure to avoid is a runner that waits for ever on
 * a value it could not understand.
 */
export function signalDelayMs(payload: unknown): number {
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const asked = record.in_ms;
  if (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0) return 0;
  return Math.min(asked, SIGNAL_MAX_DELAY_MS);
}

/**
 * What the debounce knows between signals.
 *
 * **Two moments rather than one, and the pair is exactly what is needed.** A
 * signal now names when its own work becomes claimable, and those moments differ
 * between kinds: a file arriving is claimable at once, a mention a minute later.
 * Folding a later one into an earlier read would take the read before its work
 * was there and leave nothing to ask again.
 *
 * The invariant that makes two enough: **a read at a given moment serves every
 * signal that predicted that moment or earlier.** So holding the earliest pending
 * moment and the latest pending moment covers every prediction in between — the
 * first read serves everything up to itself, and the re-armed read at the latest
 * serves the rest.
 *
 * A value rather than a live timer so the rule can be asserted without one.
 */
export interface SignalWindow {
  /** When the pending read will be taken, or null when nothing is pending. */
  readonly dueAt: number | null;
  /**
   * The latest moment a remembered signal said its work becomes claimable, or
   * null when the pending read covers everything seen.
   *
   * A moment the *work* is due rather than a read time, which is what `dueAt`
   * holds — the two are named for what they are because the floors are applied
   * when a read is armed and must not be applied twice.
   */
  readonly thenAt: number | null;
}

/** Nothing pending, which is where a run starts and where every read leaves it. */
export const noSignal: SignalWindow = { dueAt: null, thenAt: null };

/**
 * Take one signal.
 *
 * **A further signal inside the window does not move the read**, and that is the
 * property worth stating: a resetting timer under a steady stream of signals is a
 * read that never happens, which turns the busiest brain into the one the runner
 * is slowest to serve. So the first signal fixes the time and the rest are folded
 * into it — the read they wanted is the read already scheduled.
 *
 * @param window where the debounce stands
 * @param now the clock, passed in so this stays a decision
 * @param lastReadAt when a signal last caused a read, or null when none has
 * @returns the new window, and `arm` when the caller must schedule the read —
 *   `dueAt` is then when to take it, which is never sooner than the floor
 */
export function takeSignal(
  window: SignalWindow,
  now: number,
  dueInMs = 0,
  lastReadAt: number | null = null,
): { window: SignalWindow; arm: boolean } {
  if (window.dueAt === null) return { window: { dueAt: readAt(now, dueInMs, lastReadAt), thenAt: null }, arm: true };
  // **Compared on when the work becomes claimable, never on when we would like to
  // read.** The debounce is a burst-folding delay rather than a property of the
  // work, so measuring against it would stop a second signal for work that is
  // *already* claimable from folding into the read three seconds away — turning
  // one read of forty dropped files back into forty.
  const dueMoment = now + dueInMs;
  if (dueMoment <= window.dueAt) return { window, arm: false };
  // Not covered: the pending read comes before this work exists. Remembered
  // rather than armed, because moving the pending read out would delay work that
  // is already claimable in order to wait for work that is not.
  return { window: { dueAt: window.dueAt, thenAt: Math.max(window.thenAt ?? 0, dueMoment) }, arm: false };
}

/**
 * When a signal asking for `dueInMs` should actually be read.
 *
 * The debounce is a floor rather than an addition: a signal that wants to be read
 * in a minute does not also need three seconds of burst-folding on top.
 */
function readAt(now: number, dueInMs: number, lastReadAt: number | null): number {
  const ready = now + Math.max(dueInMs, SIGNAL_DEBOUNCE_MS);
  return lastReadAt === null ? ready : Math.max(ready, lastReadAt + SIGNAL_MIN_GAP_MS);
}

/**
 * The read happened: the window is open again, and says whether one more is owed.
 *
 * **A remembered moment that has already passed is not re-armed**, and that is a
 * correctness point rather than an economy: the read being completed happened at
 * `now`, so a prediction at or before `now` was already claimable when that read
 * ran and was served by it. Only a moment still in the future is work this read
 * cannot have seen.
 *
 * @param now when the read that is finishing happened
 * @param lastReadAt what the floor for a further read is measured from, which is
 *   this read: two signal-driven reads stay at least a minimum gap apart however
 *   the predictions fell
 * @returns the new window, and `arm` when the caller must schedule one more read
 */
export function clearSignal(window: SignalWindow, now: number, lastReadAt: number | null = null): {
  window: SignalWindow;
  arm: boolean;
} {
  if (window.thenAt === null || window.thenAt <= now) return { window: noSignal, arm: false };
  return { window: { dueAt: readAt(now, window.thenAt - now, lastReadAt), thenAt: null }, arm: true };
}
