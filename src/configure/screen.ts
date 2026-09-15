// The screen that asks the configure questions, one step at a time.
//
// Ink, because the agent list wants arrow keys and a mark per row, and because
// the live view `run` will one day draw wants Ink too — one rendering stack,
// chosen once. The components are `@inkjs/ui`'s rather than our own, so the
// checkbox list is not thirty lines of ours to get wrong.
//
// **Built with `createElement`, not JSX**, so that `node src/main.ts` still runs:
// Node's type stripping cannot read JSX, and the binary is not yet the only way
// to run this program. It reads slightly worse and costs nothing else.
//
// Nothing is decided here. Every default, every judgement and what the answers
// become is `questions.ts`; this file renders one question, hands the answer to
// the judgement, shows the refusal or the warning, and moves on. Ctrl-C at any
// step unmounts the tree with nothing handed back, which the command reads as
// *cancelled* and writes nothing for — though the answers given so far are in
// the draft the command wrote as they were given, so the next run offers them.
//
// **Three things about how it looks, which are requirements rather than taste.**
// Every prompt sits inside one frame with a rule down its left edge, because a
// value printed loose on a new line is indistinguishable from a shell prompt at
// a path and reads as though the program had exited. The value being edited sits
// in a bordered field for the same reason: a thing being typed into must not
// look like output. And a **refused answer comes back with what was typed in
// it**, cursor at the end — re-offering the default is the one thing that is
// certainly wrong, since the default is not what the person was trying to say.

import { createElement as h, useState, type ReactElement } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { ConfirmInput, MultiSelect, Select, TextInput } from "@inkjs/ui";
import {
  agentDefaults,
  completePath,
  DRAFT_VERSION,
  HARNESS_CREDENTIAL_VARIABLE,
  judgeBudget,
  judgeCeiling,
  judgeCwd,
  judgeDuration,
  judgeSelection,
  judgeTurns,
  judgeVariable,
  type AgentChoices,
  type AgentDefaults,
  type Answers,
  type ConfigureDraft,
  type DraftAgent,
  type Judgement,
  type RenamedEntry,
} from "./questions.ts";
import type { Config } from "../config/schema.ts";

/** Everything the screen needs to ask, gathered before it is drawn. */
export interface ScreenPlan {
  choices: AgentChoices;
  /** Organizations the account is in that hold no agent, named so their absence from the list is not silence. */
  emptyOrganizations: string[];
  /** Agents this account can see but not manage, counted so their absence is not silence either. */
  withheld: string | null;
  existing: Config | null;
  /** What a `configure` quit part-way left behind, offered ahead of the config's own values. */
  draft: ConfigureDraft | null;
  currentDirectory: string;
  env: Record<string, string | undefined>;
  isDirectory: (path: string) => boolean;
  /** The sub-directories of an absolute path, for Tab completion. */
  listDirectory: (path: string) => string[];
  /** Records what has been answered so far, after every answer. Failure here is not the sequence's problem. */
  record?: (draft: ConfigureDraft) => void;
}

/**
 * One per-agent question: what it asks, how the answer is judged, and where it
 * lands. A table rather than a switch, so a question is one row and cannot be
 * half-added.
 *
 * `skip` is what lets one answer remove a later question: choosing the harness's
 * own account means there is no variable to name, and a question with no
 * possible answer must not be asked.
 */
interface TextQuestion {
  kind: "text";
  prompt: (name: string) => string;
  /** A second, dimmer line — where a value comes from, or what a blank one means. */
  hint?: string;
  judge: (raw: string, plan: ScreenPlan) => Judgement<string | number>;
  read: (current: AgentDefaults) => string;
  write: (current: AgentDefaults, value: string | number) => AgentDefaults;
  /** Whether Tab offers directory completions here. */
  completes?: boolean;
  skip?: (current: AgentDefaults) => boolean;
}

/** One per-agent question answered by picking, not typing. */
interface ChoiceQuestion {
  kind: "choice";
  prompt: (name: string) => string;
  hint?: string;
  /** The options, most-likely first: the list is offered with the first row focused. */
  options: (current: AgentDefaults) => Array<{ label: string; value: string }>;
  write: (current: AgentDefaults, value: string) => AgentDefaults;
  skip?: (current: AgentDefaults) => boolean;
}

type AgentQuestion = TextQuestion | ChoiceQuestion;

/** The two ways an agent's harness is paid for. */
const HARNESS_FROM_ACCOUNT = "account";
const HARNESS_FROM_VARIABLE = "variable";

const AGENT_QUESTIONS: AgentQuestion[] = [
  {
    kind: "text",
    prompt: (name) => `Where does ${name} run? The directory the harness starts in — for a coding agent, its checkout.`,
    hint: "Tab completes a directory; Tab again cycles the matches.",
    judge: (raw, plan) => judgeCwd(raw, plan.currentDirectory, plan.isDirectory),
    read: (c) => c.cwd,
    write: (c, v) => ({ ...c, cwd: v as string }),
    completes: true,
  },
  {
    kind: "choice",
    prompt: (name) => `What pays for ${name}'s thinking?`,
    hint: "If you type `claude` in a shell and it just works, this machine's own account is the answer.",
    options: (c) => {
      const account = { label: "this machine's own Claude Code account", value: HARNESS_FROM_ACCOUNT };
      const variable = { label: "an API key, held in an environment variable", value: HARNESS_FROM_VARIABLE };
      return c.harnessVariable === null ? [account, variable] : [variable, account];
    },
    write: (c, value) => ({
      ...c,
      harnessVariable: value === HARNESS_FROM_ACCOUNT ? null : (c.harnessVariable ?? HARNESS_CREDENTIAL_VARIABLE),
    }),
  },
  {
    kind: "text",
    prompt: (name) => `Which environment variable holds ${name}'s harness credential?`,
    judge: (raw, plan) => judgeVariable(raw, plan.env, "credential"),
    read: (c) => c.harnessVariable ?? HARNESS_CREDENTIAL_VARIABLE,
    write: (c, v) => ({ ...c, harnessVariable: v as string }),
    skip: (c) => c.harnessVariable === null,
  },
  {
    kind: "text",
    prompt: (name) => `Most turns a session of ${name} may take.`,
    judge: (raw) => judgeTurns(raw),
    read: (c) => String(c.bounds.maxTurns),
    write: (c, v) => ({ ...c, bounds: { ...c.bounds, maxTurns: v as number } }),
  },
  {
    kind: "text",
    prompt: (name) => `Most dollars a session of ${name} may spend.`,
    judge: (raw) => judgeBudget(raw),
    read: (c) => String(c.bounds.maxBudgetUsd),
    write: (c, v) => ({ ...c, bounds: { ...c.bounds, maxBudgetUsd: v as number } }),
  },
  {
    kind: "text",
    prompt: (name) => `Longest a session of ${name} may run, with a unit (30m, 2h).`,
    judge: (raw) => judgeDuration(raw),
    read: (c) => c.bounds.wallClock,
    write: (c, v) => ({ ...c, bounds: { ...c.bounds, wallClock: v as string } }),
  },
];

/**
 * The next question that is not skipped, or null when the agent is done.
 *
 * Taken as a step rather than an increment, because whether a question exists
 * depends on an answer already given: the variable's name is not asked of an
 * agent that uses the machine's own account.
 */
function nextQuestion(current: AgentDefaults, after: number): number | null {
  for (let i = after + 1; i < AGENT_QUESTIONS.length; i += 1) {
    if (!AGENT_QUESTIONS[i].skip?.(current)) return i;
  }
  return null;
}

interface AgentAnswer extends AgentDefaults {
  name: string;
  id: string;
}

type Phase =
  | { kind: "rename"; index: number }
  | { kind: "agents" }
  | { kind: "agent"; index: number; question: number }
  | { kind: "ceiling" };

/** A Tab cycle in progress: what it was computed from, the matches, and where in them we are. */
interface Completion {
  matches: string[];
  index: number;
}

interface State {
  phase: Phase;
  /** Renamed entries the person chose NOT to keep — dropped, and reported as such. */
  dropped: RenamedEntry[];
  chosen: string[];
  agents: AgentAnswer[];
  /** The agent being asked about, built up question by question. */
  current: AgentDefaults | null;
  sessionsPerHour: number | null;
  problem: string | null;
  warning: string | null;
  /** What the field currently shows. Seeded from the answers already known, replaced by a refused answer. */
  offered: string;
  /** Bumped whenever `offered` must reach a field that is already on screen, which only a remount can do. */
  attempt: number;
  /** The live text, tracked so Tab can complete what is actually there rather than what was offered. */
  typed: string;
  completion: Completion | null;
}

/** The gutter colour: one rule down the left of every prompt, so no line reads as the shell's. */
const FRAME_COLOR = "cyan";

/** The screen. Calls `onDone` once with every answer; never called on Ctrl-C. */
function ConfigureScreen({ plan, onDone }: { plan: ScreenPlan; onDone: (answers: Answers) => void }): ReactElement {
  const { exit } = useApp();

  const optionsById = new Map(plan.choices.options.map((o) => [o.value, o]));
  const existingById = new Map(Object.entries(plan.existing?.agents ?? {}).map(([name, entry]) => [entry.id, { name, entry }]));
  const nameOf = (id: string) => optionsById.get(id)?.name ?? existingById.get(id)?.name ?? id;
  const defaultsFor = (id: string): AgentDefaults =>
    agentDefaults(nameOf(id), existingById.get(id)?.entry ?? null, plan.currentDirectory, plan.draft?.agents[id] ?? null);

  const [state, setState] = useState<State>(() => ({
    phase: plan.choices.renamed.length > 0 ? { kind: "rename", index: 0 } : { kind: "agents" },
    dropped: [],
    chosen: [],
    agents: [],
    current: null,
    sessionsPerHour: plan.draft?.sessionsPerHour ?? plan.existing?.sessionsPerHour ?? null,
    problem: null,
    warning: null,
    offered: "",
    attempt: 0,
    typed: "",
    completion: null,
  }));

  /**
   * Record and set in one place, so no path can advance the sequence without the
   * draft following it. The draft is a convenience the command writes; a failure
   * to write one never reaches here.
   */
  const advance = (next: State) => {
    setState(next);
    plan.record?.(draftOf(next));
  };

  // The field owns its own text; this is the copy Tab completes from. Written as
  // an update of whatever state is current rather than of the one this render
  // closed over, since two keystrokes can land between renders.
  const onTyped = (value: string) => setState((s) => (s.typed === value ? s : { ...s, typed: value }));

  /** Start (or restart) a field showing `value`, with nothing refused and no cycle in progress. */
  const offer = (s: State, value: string): State => ({
    ...s,
    offered: value,
    typed: value,
    attempt: s.attempt + 1,
    completion: null,
  });

  const startAgent = (s: State, index: number): State => {
    const defaults = defaultsFor(s.chosen[index]);
    const first = AGENT_QUESTIONS[0].skip?.(defaults) ? nextQuestion(defaults, 0) : 0;
    // Every question is skippable in principle; a per-agent block with none left
    // would be a table nobody could answer, so it is treated as done rather than
    // crashed.
    if (first === null) return afterAgent(s, index, defaults);
    return offer(
      { ...s, phase: { kind: "agent", index, question: first }, current: defaults, problem: null, warning: null },
      readOf(AGENT_QUESTIONS[first], defaults),
    );
  };

  /** The step after an agent's last question: the next agent, or the ceiling. */
  const afterAgent = (s: State, index: number, current: AgentDefaults): State => {
    const id = s.chosen[index];
    const agents = [...s.agents, { name: nameOf(id), id, ...current }];
    const next = { ...s, agents, current: null, problem: null };
    if (index + 1 < s.chosen.length) return startAgent(next, index + 1);
    return offer({ ...next, phase: { kind: "ceiling" } }, next.sessionsPerHour === null ? "" : String(next.sessionsPerHour));
  };

  const answerAgentText = (raw: string) => {
    if (state.phase.kind !== "agent" || !state.current) return;
    const { index, question } = state.phase;
    const q = AGENT_QUESTIONS[question];
    if (q.kind !== "text") return;
    const judged = q.judge(raw, plan);
    if (!judged.ok) {
      // The refusal keeps what was typed, so a one-character mistake costs one
      // character rather than the whole path.
      setState(offer({ ...state, problem: judged.problem, warning: null }, raw));
      return;
    }
    const current = q.write(state.current, judged.value);
    const warning = judged.warning ?? null;
    const following = nextQuestion(current, question);
    if (following !== null) {
      const moved = { ...state, current, phase: { kind: "agent" as const, index, question: following }, problem: null, warning };
      advance(offer(moved, readOf(AGENT_QUESTIONS[following], current)));
      return;
    }
    advance(afterAgent({ ...state, warning }, index, current));
  };

  const answerAgentChoice = (value: string) => {
    if (state.phase.kind !== "agent" || !state.current) return;
    const { index, question } = state.phase;
    const q = AGENT_QUESTIONS[question];
    if (q.kind !== "choice") return;
    const current = q.write(state.current, value);
    const following = nextQuestion(current, question);
    if (following !== null) {
      const moved = { ...state, current, phase: { kind: "agent" as const, index, question: following }, problem: null, warning: null };
      advance(offer(moved, readOf(AGENT_QUESTIONS[following], current)));
      return;
    }
    advance(afterAgent({ ...state, warning: null }, index, current));
  };

  /**
   * The draft as this state stands: every agent answered, plus the one in
   * progress.
   *
   * **Laid over the draft this run started from, never replacing it.** The
   * sequence records after every answer, including the rename questions that
   * come before the list is even shown — and at that point this run knows
   * nothing about agents. Writing what it knows would erase an earlier run's
   * answers on the way past the first question, which is the failure the draft
   * exists to prevent.
   */
  const draftOf = (s: State): ConfigureDraft => {
    const agents: Record<string, DraftAgent> = { ...(plan.draft?.agents ?? {}) };
    for (const a of s.agents) agents[a.id] = { id: a.id, cwd: a.cwd, harnessVariable: a.harnessVariable, bounds: a.bounds };
    if (s.phase.kind === "agent" && s.current) {
      const id = s.chosen[s.phase.index];
      agents[id] = { id, cwd: s.current.cwd, harnessVariable: s.current.harnessVariable, bounds: s.current.bounds };
    }
    return {
      version: DRAFT_VERSION,
      chosen: s.chosen.length > 0 ? s.chosen : (plan.draft?.chosen ?? []),
      agents,
      dropped: s.dropped.map((d) => d.id),
      sessionsPerHour: s.sessionsPerHour,
    };
  };

  const { phase } = state;
  const textQuestion = phase.kind === "agent" ? AGENT_QUESTIONS[phase.question] : null;
  const completes = textQuestion?.kind === "text" && textQuestion.completes === true;

  // Tab is the one key `@inkjs/ui`'s text input deliberately ignores, which is
  // what leaves it free here. The completion reaches the field by remounting it
  // with a new value, since the field owns its own text and there is no other
  // way in.
  useInput(
    (_input, key) => {
      if (!key.tab) return;
      // A completion replaces the whole answer, so a refusal of the previous one
      // stops being true of what is on screen and goes with it.
      const cycle = state.completion;
      if (cycle && cycle.matches.length > 1 && state.typed === cycle.matches[cycle.index]) {
        const index = (cycle.index + 1) % cycle.matches.length;
        setState({ ...offer(state, cycle.matches[index]), problem: null, completion: { matches: cycle.matches, index } });
        return;
      }
      const matches = completePath(state.typed, plan.currentDirectory, plan.listDirectory);
      if (matches.length === 0) return;
      setState({ ...offer(state, matches[0]), problem: null, completion: { matches, index: 0 } });
    },
    { isActive: completes },
  );

  const lines: ReactElement[] = [];
  if (state.warning) lines.push(h(Text, { key: "warning", color: "yellow" }, state.warning));
  if (state.problem) lines.push(h(Text, { key: "problem", color: "red" }, state.problem));

  let question: ReactElement;
  if (phase.kind === "rename") {
    const rename = plan.choices.renamed[phase.index];
    const advanceRename = (keep: boolean) => {
      const nextIndex = phase.index + 1;
      advance({
        ...state,
        dropped: keep ? state.dropped : [...state.dropped, rename],
        phase: nextIndex < plan.choices.renamed.length ? { kind: "rename", index: nextIndex } : { kind: "agents" },
      });
    };
    question = h(
      Box,
      { flexDirection: "column" },
      h(
        Text,
        null,
        `${rename.from} is now called ${rename.to} in the roster. Keep the entry under the new name? An entry under the old name would receive no work, so answering no drops it. `,
      ),
      h(ConfirmInput, {
        key: `rename-${phase.index}`,
        // Asked again on a re-run like every other question, but offering what
        // was said last time, so Enter repeats it rather than reversing it.
        defaultChoice: plan.draft?.dropped.includes(rename.id) ? "cancel" : "confirm",
        onConfirm: () => advanceRename(true),
        onCancel: () => advanceRename(false),
      }),
    );
  } else if (phase.kind === "agents") {
    const droppedIds = new Set(state.dropped.map((d) => d.id));
    // A draft's marks are the person's most recent answer to this same question,
    // so they stand ahead of the config's — but only when there is a draft, since
    // an empty list from one that never reached this question would unmark
    // everything the config had.
    const marked = plan.draft && plan.draft.chosen.length > 0 ? plan.draft.chosen : plan.choices.preselected;
    const preselected = marked.filter((id) => !droppedIds.has(id) && optionsById.has(id));
    const notes: ReactElement[] = [];
    if (plan.emptyOrganizations.length > 0) {
      notes.push(h(Text, { key: "empty", dimColor: true }, `No agents yet in: ${plan.emptyOrganizations.join(", ")}.`));
    }
    if (plan.withheld) notes.push(h(Text, { key: "withheld", dimColor: true }, plan.withheld));
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Which agents does this machine run? Up and down to move, space to mark, Enter to confirm."),
      ...notes,
      h(MultiSelect, {
        key: "agents",
        options: plan.choices.options,
        defaultValue: preselected,
        visibleOptionCount: Math.min(12, Math.max(1, plan.choices.options.length)),
        onSubmit: (values: string[]) => {
          const judged = judgeSelection(values, plan.choices.options);
          if (!judged.ok) setState({ ...state, problem: judged.problem });
          else advance(startAgent({ ...state, chosen: judged.value, problem: null }, 0));
        },
      }),
    );
  } else if (phase.kind === "agent") {
    const name = nameOf(state.chosen[phase.index]);
    const q = AGENT_QUESTIONS[phase.question];
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, `${name} (${phase.index + 1} of ${state.chosen.length})`),
      h(Text, null, q.prompt(name)),
      ...(q.hint ? [h(Text, { key: "hint", dimColor: true }, q.hint)] : []),
      q.kind === "choice"
        ? h(Select, {
            key: `choice-${phase.index}-${phase.question}`,
            options: q.options(state.current ?? defaultsFor(state.chosen[phase.index])),
            onChange: answerAgentChoice,
          })
        : field(`agent-${phase.index}-${phase.question}-${state.attempt}`, state, onTyped, answerAgentText),
    );
  } else {
    // The last question, so a good answer finishes rather than advancing: there
    // is no phase after this one to move to.
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Most sessions an hour this machine starts per agent. Blank keeps the server's ceiling of 10; a brain may lower it, never raise it."),
      field(`ceiling-${state.attempt}`, state, onTyped, (raw: string) => {
        const judged = judgeCeiling(raw);
        if (!judged.ok) setState(offer({ ...state, problem: judged.problem }, raw));
        else {
          // Recorded before the screen goes, so a write that fails leaves a draft
          // holding every answer rather than one short of the last.
          advance({ ...state, sessionsPerHour: judged.value, problem: null, warning: null });
          onDone({ agents: state.agents, sessionsPerHour: judged.value, dropped: state.dropped });
          exit();
        }
      }),
    );
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
    h(Text, { key: "title", color: FRAME_COLOR, bold: true }, "mdbrain configure"),
    ...lines,
    question,
  );
}

/** What a question offers as its starting value. */
function readOf(question: AgentQuestion, current: AgentDefaults): string {
  return question.kind === "text" ? question.read(current) : "";
}

/**
 * The value being edited, in something that looks like a field.
 *
 * A bordered slot rather than a bare line: an answer sitting loose under a
 * question looks like output, and on the directory question it looks exactly
 * like a shell prompt at a path. The marker and the border are the whole of what
 * says *you are still inside `configure`*.
 */
function field(
  key: string,
  state: State,
  onTyped: (value: string) => void,
  onSubmit: (raw: string) => void,
): ReactElement {
  return h(
    Box,
    { borderStyle: "round", borderColor: state.problem ? "red" : "gray", paddingLeft: 1, paddingRight: 1 },
    h(Text, { color: FRAME_COLOR }, "❯ "),
    h(TextInput, { key, defaultValue: state.offered, onChange: onTyped, onSubmit }),
  );
}

/** The element the command renders; exported so a test can draw it without a terminal. */
export function configureScreen(plan: ScreenPlan, onDone: (answers: Answers) => void): ReactElement {
  return h(ConfigureScreen, { plan, onDone });
}

/**
 * Draws the screen on the real terminal and answers with everything asked, or
 * null when the person left before the end.
 */
export async function askOnScreen(plan: ScreenPlan): Promise<Answers | null> {
  let answers: Answers | null = null;
  const app = render(configureScreen(plan, (a) => { answers = a; }), { exitOnCtrlC: true });
  await app.waitUntilExit();
  return answers;
}
