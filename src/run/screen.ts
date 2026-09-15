// The screen the live view is drawn on, and the presenter that drives it.
//
// Everything here is Ink, a clock, or a keyboard — the three things `view.ts`
// deliberately has none of. The split is `configure`'s: what is *true* is a pure
// module, and this only draws it and forwards what was pressed.
//
// **The roster is drawn even when every row is idle**, which is what it will
// spend most of its life doing. A long-running mostly-silent process that draws
// almost nothing is exactly the shape that gets mistaken for a shell that was
// handed back, so the frame, the command's name and the countdown stay on screen.
//
// **The clock lives here, and it only subtracts.** The runner says when the next
// poll is due; this counts the seconds down to it. A redraw a second is
// deliberate rather than inherited from the spinner: it is the slowest rate at
// which a number of seconds can be right.
//
// **Reading keys is what takes the interrupt away, and this is where it is given
// back.** Ink's `useInput` puts the terminal in raw mode, and a terminal in raw
// mode does not turn Ctrl-C into a signal — so `run`'s SIGINT handler, which is
// how §5f's graceful stop begins, simply stops being reached. Ctrl-C is
// therefore a binding like any other, routed to the same handler the signal
// would have reached. Losing that is not a cosmetic bug: it is a runner that
// cannot be stopped from the terminal it is running in.
//
// Built with `createElement` rather than JSX, so `node src/main.ts` still runs.

import { createElement as h, useEffect, useState, type ReactElement } from "react";
import { Box, Text, render, useInput, useStdin } from "ink";
import { Spinner } from "@inkjs/ui";
import { agoText, clockText, costText, dayText, durationText, plainLine, shortClaim, type Presenter, type RunEvent } from "./present.ts";
import { actionForKey, keyHints, type ViewRequest } from "./keys.ts";
import { OUTCOME_KINDS } from "./outcome.ts";
import {
  applyEvent,
  emptyView,
  messagePreview,
  moveSelection,
  selectedRun,
  type AgentRow,
  type RecentRun,
  type Selection,
  type ViewState,
} from "./view.ts";

/** How often the countdown redraws. One second, because that is its own unit. */
export const COUNTDOWN_TICK_MS = 1_000;

/**
 * The widths the recent list's fixed columns are held to, so the stamp at the
 * end of every row lands in one place.
 *
 * Sized to the longest each field can be rather than to the longest one on
 * screen: a column whose width came from the rows currently in it would shift
 * every time a run ended, which is the one thing a list a person is scanning
 * must not do. `23h59m` is the longest duration this list can hold — a session
 * is bounded by the wall clock — and a cost is `$` and a figure, given room for
 * one that ran into the hundreds.
 *
 * **The outcome's width is derived from the declaration and not written down.**
 * Six of the seven outcomes are longer than `failed`, so a number chosen from
 * the two a person sees most would leave every other kind pushing the columns
 * after it sideways — and the rows it happens to be wrong about are exactly the
 * ones somebody is scanning for. A kind added later widens the column by being
 * declared, which is the only way this cannot go stale.
 */
const OUTCOME_WIDTH = Math.max(...OUTCOME_KINDS.map((kind) => kind.length));
const DURATION_WIDTH = 6;
const COST_WIDTH = 7;

/** The gutter colour, the same one `configure` uses: one rule down the left of the frame. */
const FRAME_COLOR = "cyan";

/**
 * The version notice, which is the one line on this screen that asks the person
 * to go and do something. Yellow rather than the frame's cyan so it does not
 * read as furniture, and not red, which is what a failed run is.
 */
const NOTICE_COLOR = "yellow";

const STATE_COLOR: Record<AgentRow["state"], string> = { idle: "gray", running: "green", held: "yellow" };

/** The mark and the words of the one connection row, and the colour of the mark. */
export interface ConnectionRow {
  /** Green when work signals are arriving, amber while they may come back, red when they are not. */
  color: "green" | "yellow" | "red";
  /** What the light says, without the mark. */
  text: string;
  /** The presence clause, dimmed and appended — or null when presence is fine or unsaid. */
  presence: string | null;
}

/**
 * The one connection row, from the listening state and the presence one.
 *
 * **One row rather than two, and it is the listening one.** The two sockets were
 * drawn one under the other and the pair read as noise on a screen that is
 * mostly furniture; of the two, this is the one whose failure costs work. A
 * presence failure costs a dot in somebody else's browser, and it survives here
 * as a clause rather than a line of its own.
 *
 * **A word as well as a mark, because the colour is redundancy and never the
 * information.** A bare dot says nothing to a reader who is colour-blind and
 * nothing at all in a terminal that drops colour — a piped `mdbrain run`, a CI
 * log, a `tmux` with a poor palette — and this is the row somebody is reading
 * precisely when they are deciding whether the runner works.
 *
 * **`polling only` is load-bearing on every state where no signal can arrive**,
 * which is the three that carry it and not `partial`. The countdown to the
 * catch-up sweep is drawn on the very next line, so the two together say the
 * whole thing: work is arriving by that sweep, and the next one is in so many
 * minutes. That pairing is what keeps a runner that has gone deaf from also
 * being invisible.
 *
 * `partial` is amber and says none of it, deliberately: some rooms are held, so
 * signals do still arrive and *polling only* would be false. What it says instead
 * is the count, which is the fact a reader of a partly-connected runner needs.
 *
 * **Presence never changes the colour**, only adds its clause. The colour belongs
 * to the consequence this row is about, and reddening the work-signal light for a
 * presence failure would say the more expensive thing had happened.
 *
 * Pure, and exported, so the whole vocabulary is assertable without a terminal —
 * which is the property that made it safe to stop composing this sentence in the
 * reducer.
 *
 * **A presence state with no listening state draws nothing, and that is a
 * consequence worth naming rather than an oversight.** Presence has no row of
 * its own any more, only a clause on this one, so there is nowhere for it to land
 * until the runner has said where it is listening — and inventing a mark and a
 * word for a presence-only row would be inventing vocabulary this spec does not
 * have. In practice the gap is milliseconds: `run` says a listening state before
 * its first tick either way, because a lookup that came back opens a link that
 * reports, and a lookup that came back empty makes the runner say `silent`
 * itself. What it does cost is a runner whose link never reports at all, which
 * would hide a presence failure as well as its own.
 *
 * @param listening where the work-signal socket stands, or null if unsaid
 * @param connection where presence stands, or null if unsaid
 * @returns the row, or null when the runner has not said where it is listening —
 *   silence rather than a claim, exactly as the two separate lines did
 */
export function connectionRow(
  listening: ViewState["listening"],
  connection: ViewState["connection"],
): ConnectionRow | null {
  if (listening === null) return null;
  const { state, held, total } = listening;
  const brains = (n: number) => `${n} ${n === 1 ? "brain" : "brains"}`;
  const light = ((): Omit<ConnectionRow, "presence"> => {
    switch (state) {
      case "listening":
        // No count here, because the count is the half nobody is reading this
        // row for. A healthy row answers one question — is the runner hearing
        // anything — and *for work* answers it in the words the run log
        // already uses (`listeningText`). The number returns the moment it
        // means something: `partial` says how many of how many are held, and
        // `silent` says there are none.
        return { color: "green", text: "listening for work" };
      case "partial":
        return { color: "yellow", text: `listening · ${held} of ${brains(total)}` };
      case "retrying":
        return { color: "yellow", text: "reconnecting · polling only" };
      case "unavailable":
        return { color: "red", text: "not listening · polling only" };
      case "silent":
        return { color: "red", text: "no brains to listen to · polling only" };
    }
  })();
  // Said only when it is not connected, and not at all until the runner has
  // said: presence being fine is furniture, and a screen that filled the
  // silence would be inventing the one state a person would act on.
  const presence = connection !== null && connection !== "connected" ? "presence down" : null;
  return { ...light, presence };
}

/** One agent's row: its state, the spinner when it is running, and what it is doing. */
function agentLine(row: AgentRow, width: number): ReactElement {
  const trailing: string[] = [];
  if (row.queued > 0) trailing.push(`${row.queued} waiting`);
  if (row.note !== null) trailing.push(row.note);
  return h(
    Box,
    { key: row.agent },
    h(Text, { color: STATE_COLOR[row.state] }, `  ${row.agent.padEnd(width)}  `),
    row.state === "running"
      ? h(Spinner, { label: trailing.length > 0 ? trailing.join(" · ") : "running" })
      : h(
          Text,
          { color: STATE_COLOR[row.state], dimColor: row.state === "idle" },
          row.state === "held"
            ? `held — ${row.note ?? ""}`
            : trailing.length > 0
              ? `idle · ${trailing.join(" · ")}`
              : "idle",
        ),
  );
}

/**
 * What the countdown says, given the runner's phase and the moment it is read.
 *
 * Pure and exported so a test can read it without a terminal or a real clock.
 * A deadline already past reads as *due now* rather than as a negative number:
 * the poll is a turn of the loop away and the arithmetic saying otherwise is the
 * clock's rounding, not a fact about the runner.
 *
 * **It counts down to a catch-up sweep rather than to the next poll, and both
 * words are load-bearing.** The socket above it is live and work usually
 * arrives on it within seconds of landing; this deadline is the sweep that
 * collects whatever the listening missed. At forty-five minutes a line reading
 * *next poll in 36 minutes* invites the one misreading that costs something —
 * that the number is counting down to the only thing that is going to happen —
 * and the ways to act on that misreading are to sit and watch it or to press
 * poll-now repeatedly. *Catch-up* says the sweep collects what was missed
 * rather than doing the whole job, and *sweep* says it is a tidying pass over
 * something already handled.
 *
 * **When the socket is unhealthy the sweep is the whole route rather than a
 * catch-up, and the row above is what says so.** This line is deliberately the
 * same in both worlds: `polling only` is drawn immediately above it and carries
 * that difference, and a countdown whose words changed underneath a reader
 * would cost more than the understatement it fixed.
 *
 * **A runner that will not poll again says so instead of counting.** Otherwise
 * the countdown keeps running through a shutdown, or through the whole of a
 * `--once` run waiting on its sessions, and counts down to a poll that is never
 * coming — which is the one kind of lie a screen like this can tell.
 */
export function countdownText(state: ViewState, now: number): string | null {
  switch (state.poll.kind) {
    case "unknown":
      return null;
    case "polling":
      return "polling now";
    case "finishing":
      return "no more polls — waiting for the sessions that are running";
    case "waiting": {
      const left = state.poll.at - now;
      return left <= 0 ? "catch-up sweep due now" : `catch-up sweep in ${durationText(left)}`;
    }
  }
}

/**
 * The run the cursor is on, drawn in full.
 *
 * **The message is the whole point of this block.** A row in the recent list
 * says a session failed; only the harness’s own words say why, and until now the
 * only place they existed was a line in `runs.jsonl` that a person had to leave
 * the program to read. The claim is shown beside them because it is the id that
 * row is keyed on, so the detail points at the rest of the record without this
 * view ever reading it.
 */
function runDetail(run: RecentRun, now: number): ReactElement[] {
  const { text, truncated } = messagePreview(run.message);
  const children: ReactElement[] = [
    h(Text, { key: "detail-heading", color: FRAME_COLOR }, "The run you picked"),
    h(
      Text,
      { key: "detail-head", color: run.outcome === "done" ? "green" : "red" },
      `  ${run.agent}  ${run.outcome}  ${durationText(run.ms)}  ${costText(run.costUsd)}  claim ${shortClaim(run.claim)}`,
    ),
    // The date belongs here rather than on the row: this is the one place with
    // room for it, and a row that carried it would push the message's own line
    // off a narrow terminal to answer a question the row's age already answers.
    h(
      Text,
      { key: "detail-when", dimColor: true },
      `  ended ${dayText(run.at)}, ${clockText(run.at)} · ${agoText(now - run.at.getTime())}`,
    ),
  ];
  children.push(h(Text, { key: "detail-message" }, `  ${text === "" ? "(the harness said nothing)" : text}`));
  if (truncated) {
    children.push(
      h(Text, { key: "detail-more", dimColor: true }, `  The rest of it is in the run log, on the row for claim ${shortClaim(run.claim)}.`),
    );
  }
  return children;
}

/** What the screen needs beyond the runner’s own state to draw one frame. */
export interface ScreenFrame {
  /** The moment the countdown is read against, in epoch milliseconds. */
  now: number;
  /**
   * Whether keys are being read, which decides whether they are offered — a
   * hint naming a key nothing is listening for is worse than no hint at all.
   */
  keysActive: boolean;
  /** Which recent run is open, which is the person’s state and not the runner’s. */
  selection: Selection;
}

/** The whole screen. Exported so a test can draw it with its own clock. */
export function liveView(state: ViewState, frame: ScreenFrame): ReactElement {
  const { now, keysActive, selection } = frame;
  // One width for both lists rather than one each: they are two blocks of the
  // same screen a few lines apart, and a name column that changed width halfway
  // down reads as two unrelated tables. The recent list is included because it
  // can hold an agent the roster does not — an event about an agent the view was
  // never told about is still drawn, which is the point of that rule.
  const width = Math.max(1, ...state.agents.map((a) => a.agent.length), ...state.recent.map((r) => r.agent.length));
  const children: ReactElement[] = [h(Text, { key: "title", color: FRAME_COLOR, bold: true }, "mdbrain run")];
  for (const line of state.summary.slice(1)) {
    children.push(h(Text, { key: `summary-${line}`, dimColor: true }, line));
  }
  children.push(h(Text, { key: "agents-heading", color: FRAME_COLOR }, "Agents"));
  if (state.agents.length === 0) {
    children.push(h(Text, { key: "no-agents", dimColor: true }, "  (none configured)"));
  } else {
    for (const row of state.agents) children.push(agentLine(row, width));
  }

  children.push(h(Text, { key: "recent-heading", color: FRAME_COLOR }, "Recent runs"));
  const open = selectedRun(state.recent, selection);
  if (state.recent.length === 0) {
    children.push(h(Text, { key: "no-recent", dimColor: true }, "  (none this session)"));
  } else {
    state.recent.forEach((run) => {
      // The cursor is a mark in the gutter rather than a highlight, so a row
      // reads the same whether or not the terminal honours inverse video.
      const picked = open !== null && open.claim === run.claim;
      children.push(
        h(
          Text,
          // Keyed on the claim rather than the position, for the same reason the
          // cursor is: the list grows from the top and a row is not the run it
          // was a moment ago.
          { key: `recent-${run.claim}`, color: run.outcome === "done" ? "green" : "red", bold: picked },
          // The clock and the age together, which is the pair the question is
          // actually asked in: the clock alone cannot tell this morning from
          // yesterday morning, and the age alone gives a person nothing to match
          // against the log's own stamp. The age is a rendering of `run.at` and
          // moves on the countdown's timer for the same reason its second hand
          // does — the runner's state does not move with it.
          //
          // **Every field before it is padded, and that is what makes the column
          // readable rather than merely present.** Four variable-width fields
          // sat between the row's start and this one, so the stamps landed in
          // five different places and the eye had to find each one — which is
          // the whole of what *at a glance* costs when it is got wrong.
          `${picked ? "› " : "  "}${run.agent.padEnd(width)}  ${run.outcome.padEnd(OUTCOME_WIDTH)}  ${durationText(run.ms).padStart(DURATION_WIDTH)}  ${costText(run.costUsd).padStart(COST_WIDTH)}  ${clockText(run.at)} · ${agoText(now - run.at.getTime())}`,
        ),
      );
    });
  }
  if (open !== null) children.push(...runDetail(open, now));

  // The version notice sits beside the note rather than in either list above:
  // it is a fact about the program, not about an agent or a run, so a row in
  // the roster would be the wrong shape for it and the recent list is a record
  // of sessions. It is drawn *above* the note because it outlives one — a note
  // is the last thing that happened and this stays true until the runner is
  // restarted, so the transient line belongs nearer the countdown that also
  // moves. It is coloured rather than dimmed for the same reason: this is the
  // one line here that is asking the person to do something.
  if (state.versionNotice !== null) {
    children.push(h(Text, { key: "version", color: NOTICE_COLOR }, `  ${state.versionNotice}`));
  }
  if (state.note !== null) children.push(h(Text, { key: "note", dimColor: true }, `  ${state.note}`));
  // Below the note and above the countdown, which is the pairing that makes an
  // unhealthy state readable: this row says work is arriving by poll and the
  // next line says when the next one is.
  const row = connectionRow(state.listening, state.connection);
  if (row !== null) {
    children.push(
      h(
        Text,
        { key: "connection", color: row.color },
        `  ● ${row.text}`,
        // Nested rather than concatenated, so the clause is dimmed while the
        // light keeps its colour — presence is a footnote on this row and must
        // not read as the thing the colour is about.
        row.presence === null ? null : h(Text, { key: "presence", dimColor: true }, ` · ${row.presence}`),
      ),
    );
  }

  const countdown = countdownText(state, now);
  if (countdown !== null) children.push(h(Text, { key: "countdown", color: FRAME_COLOR }, `  ${countdown}`));
  // The keys are named on screen rather than left to be known. A terminal whose
  // stdin cannot be put in raw mode reads none, and offering them there would be
  // an instruction that does nothing.
  if (keysActive) children.push(h(Text, { key: "keys", dimColor: true }, `  ${keyHints().join("   ")}`));

  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: FRAME_COLOR,
      borderTop: false,
      borderRight: false,
      borderBottom: false,
      paddingLeft: 1,
    },
    ...children,
  );
}

/** What the presenter hands the screen: the state to draw, and where a key goes. */
interface ScreenProps {
  state: ViewState;
  onRequest: (request: ViewRequest) => void;
}

/**
 * The live screen: the state drawn, the countdown ticking, the keys read.
 *
 * **It holds two things of its own, and neither is the runner's.** `now` exists
 * so the countdown can subtract and a recent run can say how long ago it was,
 * and the timer behind it runs **whenever either of those is on screen**.
 * `selection` is which recent run the person opened, which is a fact about the
 * person rather than about the runner, and is exactly why the keys that move it
 * never leave this component while the two that ask the runner for something
 * always do.
 *
 * **The condition is two things and not one, which is what the ages cost.** It
 * was the deadline alone, which was right while the countdown was the only
 * clock-derived value: a runner that is polling, or one that has not said yet,
 * had nothing on screen that moved. An age moves whether or not a poll is
 * coming — and the phases with no deadline are exactly the long ones, `--once`
 * waiting out its sessions, a stop giving them their grace, a session the server
 * has ended. Left gated on the deadline, a run under `--once` freezes `now` at
 * mount and every row reads *just now* for the rest of the process.
 */
function LiveScreen({ state, onRequest }: ScreenProps): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  const [selection, setSelection] = useState<Selection>(null);
  const deadline = state.poll.kind === "waiting" ? state.poll.at : null;
  const ticking = deadline !== null || state.recent.length > 0;
  useEffect(() => {
    if (!ticking) return;
    // Read the clock once on arrival too: whatever started this is new, and
    // waiting a whole second before the first number would show a countdown —
    // or an age — that starts late by exactly the interval it moves in.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [deadline, ticking]);

  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      const action = actionForKey(input, key);
      // A key this view does not offer is ignored rather than guessed at.
      if (action === null) return;
      if (action.to === "loop") onRequest(action.request);
      else setSelection((current) => moveSelection(state.recent, current, action.action));
    },
    { isActive: isRawModeSupported },
  );

  return liveView(state, { now, keysActive: isRawModeSupported, selection });
}

/** The screen as an element, so a test can drive its keys without a terminal. */
export function liveScreenFor(state: ViewState, onRequest: (request: ViewRequest) => void = () => {}): ReactElement {
  return h(LiveScreen, { state, onRequest });
}

/**
 * The live presenter: the same events, drawn rather than printed.
 *
 * The stopping line is printed after the view is unmounted rather than drawn
 * inside it, because it is the one thing a person reads once the screen is gone.
 *
 * The request handler starts as a no-op and is replaced by `listen`, because the
 * screen is drawn before the loop that answers a keypress exists — and a key
 * pressed in that window should do nothing rather than reach a half-built runner.
 */
export function livePresenter(out: (line: string) => void, now: () => Date = () => new Date()): Presenter {
  let state = emptyView;
  let handler: (request: ViewRequest) => void = () => {};
  const forward = (request: ViewRequest) => handler(request);
  const app = render(h(LiveScreen, { state, onRequest: forward }), { exitOnCtrlC: false });
  let live = true;

  const unmount = () => {
    if (!live) return;
    live = false;
    app.unmount();
  };

  return {
    present(event, at) {
      if (event.kind === "stopped") {
        unmount();
        const text = plainLine({ at: at ?? now(), event });
        if (text !== null) out(text);
        return;
      }
      state = applyEvent(state, event, at ?? now());
      if (live) app.rerender(h(LiveScreen, { state, onRequest: forward }));
    },
    listen(next) {
      handler = next;
    },
    async stop() {
      unmount();
      await app.waitUntilExit();
    },
  };
}

