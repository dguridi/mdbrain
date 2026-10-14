// The `mdbrain agents` browser: the agents this machine holds on the left, the
// picked one's configuration and verdict on the right.
//
// **Read-only until a key is pressed.** Opening it checks every agent's key —
// which is a read, of the server's opinion of a key — and writes nothing: no
// config, no connection file, no key store, no revoke. The two keys that do
// write, `r` and `d`, each show what they are about to do and wait for `y`, so
// the screen is safe to open on any machine just to look.
//
// Nothing is decided here. The verdicts are `verdict.ts`'s, the keys are
// `keys.ts`'s, and every write is a callback the command hands in; this draws
// the state and routes the keys.
//
// **Built with `createElement`, not JSX**, so that `node src/main.ts` still runs.

import { createElement as h, useEffect, useRef, useState, type ReactElement } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { browserActionFor, browserHints } from "./keys.ts";
import { verdictBadge, verdictSentence, type Verdict } from "./verdict.ts";

/** The gutter colour, shared with the other screens so one program looks like one program. */
const FRAME_COLOR = "cyan";

/** One configured agent as the browser lists it. */
export interface BrowserRow {
  name: string;
  /** The report's lines for it, from `agentLines`. */
  lines: string[];
  heldPrefix: string | null;
}

/** What a write hands back: what to say about it, and the rows as they now are. */
export interface ActionResult {
  lines: string[];
  rows: BrowserRow[];
}

/** Everything the browser needs, gathered by the command before it is drawn. */
export interface BrowserPlan {
  /** Where things are, from `locationLines`. */
  locations: string[];
  rows: BrowserRow[];
  /** The verdict on one agent's key. A read, safe to run as often as asked. */
  check: (name: string) => Promise<Verdict>;
  /** What renewing an agent's key would do, said before it is done. */
  renewPlan: (name: string) => string[];
  /** What removing an agent's configuration would do, said before it is done. */
  removePlan: (name: string) => string[];
  renew: (name: string) => Promise<ActionResult>;
  remove: (name: string) => Promise<ActionResult>;
}

type Mode =
  | { kind: "browse" }
  | { kind: "confirm"; action: "renew" | "remove"; name: string }
  | { kind: "working"; what: string };

function colorOf(verdict: Verdict | null | undefined): string {
  if (!verdict) return "gray";
  if (verdict.kind === "accepted") return "green";
  if (verdict.kind === "unchecked") return "yellow";
  return "red";
}

function AgentsBrowser({ plan }: { plan: BrowserPlan }): ReactElement {
  const { exit } = useApp();
  const [rows, setRows] = useState<BrowserRow[]>(plan.rows);
  const [cursor, setCursor] = useState(0);
  const [verdicts, setVerdicts] = useState<Record<string, Verdict | null>>({});
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [notice, setNotice] = useState<string[]>([]);
  // A check that lands after the screen is gone must not set state on it.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const check = (name: string) => {
    setVerdicts((v) => ({ ...v, [name]: null }));
    void plan.check(name).then(
      (verdict) => { if (mounted.current) setVerdicts((v) => ({ ...v, [name]: verdict })); },
      (cause: unknown) => {
        if (mounted.current) setVerdicts((v) => ({ ...v, [name]: { kind: "unchecked", reason: (cause as Error).message } }));
      },
    );
  };

  // Every agent is checked as soon as the screen opens, and each row fills in as
  // its answer lands, so a slow server delays one row and not the screen.
  useEffect(() => {
    for (const row of plan.rows) check(row.name);
  }, []);

  const act = (action: "renew" | "remove", name: string) => {
    setMode({ kind: "working", what: action === "renew" ? `Renewing ${name}'s key…` : `Removing ${name}…` });
    void (action === "renew" ? plan.renew(name) : plan.remove(name)).then(
      (result) => {
        if (!mounted.current) return;
        setNotice(result.lines);
        setRows(result.rows);
        setCursor((c) => Math.min(c, Math.max(0, result.rows.length - 1)));
        setMode({ kind: "browse" });
        // What changed is checked again: a renewed key is the point of asking.
        if (action === "renew") check(name);
      },
      (cause: unknown) => {
        if (!mounted.current) return;
        setNotice([(cause as Error).message]);
        setMode({ kind: "browse" });
      },
    );
  };

  useInput(
    (input, key) => {
      // While a write is in flight only Ctrl-C is read, and it leaves: a request
      // the network never answers must not take the way out of the screen with it.
      if (mode.kind === "working") {
        if (input === "c" && key.ctrl) exit();
        return;
      }
      // `y` and only `y` goes ahead, and every other key backs out — Ctrl-C
      // included, which here means *not that* rather than *leave*.
      if (mode.kind === "confirm") {
        if (input === "y" && !key.ctrl) act(mode.action, mode.name);
        else setMode({ kind: "browse" });
        return;
      }
      const action = browserActionFor(input, key);
      if (action === "quit") return exit();
      const picked = rows[cursor];
      if (action === "up") setCursor((c) => Math.max(0, c - 1));
      else if (action === "down") setCursor((c) => Math.min(rows.length - 1, c + 1));
      else if (picked === undefined) return;
      else if (action === "check") check(picked.name);
      else if (action === "renew" || action === "remove") {
        setNotice([]);
        setMode({ kind: "confirm", action, name: picked.name });
      }
    },

  );

  const width = Math.max(8, ...rows.map((r) => r.name.length));
  const list = rows.length === 0
    ? [h(Text, { key: "none", dimColor: true }, "No agents are configured here any more.")]
    : rows.map((row, i) =>
        h(
          Text,
          { key: row.name, color: colorOf(verdicts[row.name]), bold: i === cursor },
          `${i === cursor ? "›" : " "} ${row.name.padEnd(width)}  ${verdictBadge(verdicts[row.name] ?? null)}`,
        ),
      );
  const picked = rows[cursor];
  const pickedVerdict = picked ? verdicts[picked.name] : undefined;
  const detail = picked
    ? [
        // Indented by padding rather than by the spaces the report carries, so a
        // long path that wraps keeps its indent on the next line.
        ...picked.lines.map((line, i) =>
          i === 0
            ? h(Text, { key: "name", bold: true }, line)
            : h(Box, { key: `l${i}`, paddingLeft: 2 }, h(Text, null, line.trimStart())),
        ),
        h(
          Box,
          { key: "verdict", paddingLeft: 2 },
          h(
            Text,
            { color: colorOf(pickedVerdict) },
            pickedVerdict ? verdictSentence(picked.name, pickedVerdict, picked.heldPrefix) : "checking…",
          ),
        ),
      ]
    : [];

  let footer: ReactElement;
  if (mode.kind === "confirm") {
    const lines = mode.action === "renew" ? plan.renewPlan(mode.name) : plan.removePlan(mode.name);
    footer = h(
      Box,
      { flexDirection: "column" },
      ...lines.map((line, i) => h(Text, { key: `p${i}` }, line)),
      h(Text, { key: "ask", bold: true }, CONFIRM_PROMPT),
    );
  } else if (mode.kind === "working") {
    footer = h(Text, { color: "yellow" }, mode.what);
  } else {
    footer = h(Text, { dimColor: true }, browserHints());
  }

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
    h(Text, { key: "title", color: FRAME_COLOR, bold: true }, "mdbrain agents"),
    ...plan.locations.map((line, i) => h(Text, { key: `at${i}`, dimColor: true }, line)),
    h(Text, { key: "gap" }, " "),
    h(
      Box,
      { key: "panes", flexDirection: "row" },
      // The list never yields width: a badge wrapped under its name reads as a
      // second agent. The right-hand pane is the one that wraps.
      h(Box, { flexDirection: "column", marginRight: 3, flexShrink: 0 }, ...list),
      h(Box, { flexDirection: "column", flexGrow: 1 }, ...detail),
    ),
    ...notice.map((line, i) => h(Text, { key: `n${i}`, color: "yellow" }, line)),
    h(Box, { key: "footer", marginTop: 1 }, footer),
  );
}

/** The element the command renders; exported so a test can draw it without a terminal. */
export function agentsBrowser(plan: BrowserPlan): ReactElement {
  return h(AgentsBrowser, { plan });
}

/** Draws the browser on the real terminal and resolves when the person leaves it. */
export async function browseOnScreen(plan: BrowserPlan): Promise<void> {
  const app = render(agentsBrowser(plan), { exitOnCtrlC: false });
  await app.waitUntilExit();
}

/** The question under every plan: one key that goes ahead, and every other one backs out. */
const CONFIRM_PROMPT = "y to go ahead, any other key to back out";

function Confirm({ lines, onAnswer }: { lines: string[]; onAnswer: (yes: boolean) => void }): ReactElement {
  const { exit } = useApp();
  useInput((input, key) => {
    onAnswer(input === "y" && !key.ctrl);
    exit();
  });
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
    h(Text, { key: "title", color: FRAME_COLOR, bold: true }, "mdbrain agents"),
    ...lines.map((line, i) => h(Text, { key: `p${i}` }, line)),
    h(Text, { key: "ask", bold: true }, CONFIRM_PROMPT),
  );
}

/** The element the confirmation renders; exported so a test can draw it. */
export function confirmScreen(lines: string[], onAnswer: (yes: boolean) => void): ReactElement {
  return h(Confirm, { lines, onAnswer });
}

/**
 * Shows what is about to happen and answers whether the person said yes.
 * Anything but yes — including Ctrl-C — is no.
 */
export async function confirmOnScreen(lines: string[]): Promise<boolean> {
  let yes = false;
  // Ctrl-C is read as a key here rather than as an exit, so it answers no like any other.
  const app = render(confirmScreen(lines, (a) => { yes = a; }), { exitOnCtrlC: false });
  await app.waitUntilExit();
  return yes;
}
