// The list `as` draws when the name it was given does not pick out one agent.
//
// One question and no sequence: this asks which agent and then gets out of the
// way, because the terminal it is drawing on is about to belong to the harness.
// Nothing is decided here — what the rows are and what the question says is
// `choose.ts`; this renders them and answers with the row that was chosen.
//
// **Built with `createElement`, not JSX**, so that `node src/main.ts` still runs:
// Node's type stripping cannot read JSX.
//
// It is framed the way `configure`'s questions are, and for the same reason: a
// list printed loose above a shell prompt reads as though the program had
// already exited and left its output behind.

import { createElement as h, type ReactElement } from "react";
import { Box, Text, render, useApp } from "ink";
import { Select } from "@inkjs/ui";
import { pickerHeading } from "./choose.ts";

/** The gutter colour, shared with `configure` so one program looks like one program. */
const FRAME_COLOR = "cyan";

/** How many rows are shown at once before the list scrolls. */
const VISIBLE_ROWS = 12;

function AgentPicker({
  options,
  typed,
  onPick,
}: {
  options: string[];
  typed: string | null;
  onPick: (name: string) => void;
}): ReactElement {
  const { exit } = useApp();
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
    h(Text, { key: "title", color: FRAME_COLOR, bold: true }, "mdbrain as"),
    h(Text, { key: "question" }, pickerHeading(typed, options)),
    h(Text, { key: "hint", dimColor: true }, "Up and down to move, Enter to start a session as it, Ctrl-C to leave."),
    h(Select, {
      key: "agents",
      options: options.map((name) => ({ label: name, value: name })),
      visibleOptionCount: Math.min(VISIBLE_ROWS, Math.max(1, options.length)),
      onChange: (value: string) => {
        onPick(value);
        exit();
      },
    }),
  );
}

/** The element the command renders; exported so a test can draw it without a terminal. */
export function agentPicker(options: string[], typed: string | null, onPick: (name: string) => void): ReactElement {
  return h(AgentPicker, { options, typed, onPick });
}

/**
 * Draws the list on the real terminal and answers with the agent chosen, or null
 * when the person left without choosing one.
 *
 * **It resolves only once the tree is unmounted**, which is what makes it safe to
 * spawn straight afterwards: Ink owns the terminal until it exits, and a harness
 * inheriting the streams underneath a live render would be drawing over it.
 */
export async function pickOnScreen(options: string[], typed: string | null): Promise<string | null> {
  let picked: string | null = null;
  const app = render(agentPicker(options, typed, (name) => { picked = name; }), { exitOnCtrlC: true });
  await app.waitUntilExit();
  return picked;
}
