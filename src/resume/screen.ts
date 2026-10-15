// The list `mdbrain resume` draws: one row per session that started and never
// ended, a cursor, and two things to do with the row under it.
//
// Its own small list rather than `@inkjs/ui`'s `Select`, which `as` uses,
// because this one needs what that cannot give: rows that are drawn but cannot
// be chosen, and a second key (`x`) acting on whichever row the cursor is on.
// Nothing is decided here — which rows exist and what each says is `rows.ts`;
// this draws them and answers with what the person asked for.
//
// **It writes nothing.** A dismissal is answered to the command, which removes
// the file and draws the list again, so the screen holds no disk and a test can
// drive every key without one.
//
// **Built with `createElement`, not JSX**, so that `node src/main.ts` still runs.

import { createElement as h, useState, type ReactElement } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { HAZARD_LINE, nameWidth, rowText, type ResumeRow } from "./rows.ts";

/** The gutter colour, shared with `configure` and `as`. */
const FRAME_COLOR = "cyan";

/** What the person asked for, or null when they left. */
export type PickAnswer = { kind: "resume"; claim: string } | { kind: "dismiss"; claim: string } | null;

function SessionPicker({ rows, now, onAnswer }: { rows: ResumeRow[]; now: number; onAnswer: (answer: PickAnswer) => void }): ReactElement {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  /** The claim a dismissal is waiting on `y` for, or null. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const width = nameWidth(rows);

  const finish = (answer: PickAnswer) => {
    onAnswer(answer);
    exit();
  };

  useInput((input, key) => {
    const row = rows[cursor];
    if (confirming !== null) {
      // Any key but `y` is a no, so a dismissal is never one stray keypress.
      if (input === "y") finish({ kind: "dismiss", claim: confirming });
      else setConfirming(null);
      return;
    }
    if (key.escape || (key.ctrl && input === "c")) {
      finish(null);
      return;
    }
    if (key.upArrow) {
      setCursor((at) => Math.max(0, at - 1));
      setSaid(null);
      return;
    }
    if (key.downArrow) {
      setCursor((at) => Math.min(rows.length - 1, at + 1));
      setSaid(null);
      return;
    }
    if (row === undefined) return;
    if (key.return) {
      if (row.state.kind === "resumable") finish({ kind: "resume", claim: row.record.claim });
      else setSaid(row.state.kind === "running" ? "That session is still running." : "That agent is no longer configured here, so it cannot be resumed. x dismisses it.");
      return;
    }
    // A running row can be dismissed too, after a sharper question: *running* is
    // read off a pid, and a pid the system has handed to something else would
    // otherwise pin a dead session in this list for good. Dismissing removes
    // the record only — never a process and never a transcript.
    if (input === "x") setConfirming(row.record.claim);
  });

  const children: ReactElement[] = [
    h(Text, { key: "title", color: FRAME_COLOR, bold: true }, "mdbrain resume"),
    h(Text, { key: "question" }, "Which session should be picked up again?"),
  ];
  rows.forEach((row, at) => {
    const picked = at === cursor;
    const choosable = row.state.kind === "resumable";
    children.push(
      h(
        Text,
        { key: row.record.claim, bold: picked, dimColor: !choosable },
        `${picked ? "› " : "  "}${rowText(row, now, width)}`,
      ),
    );
  });
  children.push(h(Text, { key: "hazard", color: "yellow" }, HAZARD_LINE));
  if (confirming !== null) {
    const running = rows.find((row) => row.record.claim === confirming)?.state.kind === "running";
    children.push(
      h(
        Text,
        { key: "confirm" },
        running
          ? "That session looks like it is still running. Dismiss it only if you know it is not; its record is removed and nothing is stopped. y to confirm, any other key to keep it."
          : "Dismiss this session? Its record is removed; the transcript is left alone. y to confirm, any other key to keep it.",
      ),
    );
  } else if (said !== null) {
    children.push(h(Text, { key: "said", dimColor: true }, said));
  }
  children.push(h(Text, { key: "hint", dimColor: true }, "Up and down to move, Enter to resume, x to dismiss, Esc to leave."));

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

/** The element the command renders; exported so a test can draw it without a terminal. */
export function sessionPicker(rows: ResumeRow[], now: number, onAnswer: (answer: PickAnswer) => void): ReactElement {
  return h(SessionPicker, { rows, now, onAnswer });
}

/**
 * Draws the list on the real terminal and answers with what was asked for.
 *
 * **It resolves only once the tree is unmounted**, which is what makes it safe to
 * hand the terminal to a harness straight afterwards — the rule `as`'s own
 * picker has, for the same reason.
 */
export async function pickSessionOnScreen(rows: ResumeRow[], now: number): Promise<PickAnswer> {
  let answer: PickAnswer = null;
  const app = render(sessionPicker(rows, now, (given) => { answer = given; }), { exitOnCtrlC: false });
  await app.waitUntilExit();
  return answer;
}
