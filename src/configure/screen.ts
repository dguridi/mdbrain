// The screen that asks the configure questions: a walk on the first run, a menu
// on every run after.
//
// Ink, because the agent list wants arrow keys and a mark per row, and because
// the live view `run` draws wants Ink too — one rendering stack, chosen once. The
// form components are `@inkjs/ui`'s rather than our own, so the checkbox list is
// not thirty lines of ours to get wrong.
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
// **Two ways through, over one table of questions.** With no config, the walk:
// the agent list, the pollers, each agent's questions, the ceiling — and nothing
// about limits, since every agent starts with none. With a config, the rename and
// carry-over questions come first, because they decide which agents there are,
// and then a menu: each agent with its summary, then *Add or remove agents…*,
// *Sessions an hour* and *Save and leave*. An agent opens onto its rows, and a
// row is edited with the walk's own question and judge, so no setting is
// defined twice. ↑/↓ move, Enter opens, Esc goes back one level — the keys
// `mdbrain agents` uses — and Esc at the top asks before losing changes.
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
  agentRows,
  agentSummary,
  assembleConfig,
  changesLabel,
  completePath,
  countChanges,
  DRAFT_VERSION,
  HARNESS_CREDENTIAL_VARIABLE,
  judgeBudget,
  judgeCeiling,
  judgeCwd,
  judgeDuration,
  judgeSelection,
  judgeVariable,
  GONE_FROM_ROSTER,
  pollingChoices,
  type AgentChoices,
  type AgentDefaults,
  type AgentRowKind,
  type Answers,
  type ConfigureDraft,
  type DraftAgent,
  type Judgement,
  type RecreatedEntry,
  type RenamedEntry,
} from "./questions.ts";
import { SESSION_CAP_HARD_MAX, type Config, type Limits } from "../config/schema.ts";
import { NO_LIMIT_NOTE_MS } from "../run/loop.ts";

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
  /**
   * The id of the agent whose rows the menu opens on, for `e` in `mdbrain
   * agents`. Ignored when there is no menu, or no such agent on it.
   */
  openAt?: string;
  /**
   * Changes saving would make that no answer on the screen shows: an old
   * `bounds` the rewrite drops, and `--new-keys`, which mints on save. Counted
   * with the rest, so Esc asks before leaving them undone rather than calling
   * the menu unchanged.
   */
  pending?: number;
}

/**
 * One per-agent question: what it asks, how the answer is judged, and where it
 * lands. A table rather than a switch, so a question is one row and cannot be
 * half-added — and the menu edits a setting through the same row the walk asks
 * it with, so the two cannot judge one answer two ways.
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

/** The questions, by the setting they answer, so the menu's rows can name one. */
const CWD_QUESTION = 0;
const HARNESS_QUESTION = 1;
const VARIABLE_QUESTION = 2;

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
];

/** The menu row each setting is edited through, beside the question that asks it. */
const QUESTION_FOR_ROW: Partial<Record<AgentRowKind, number>> = {
  cwd: CWD_QUESTION,
  harness: HARNESS_QUESTION,
  variable: VARIABLE_QUESTION,
};

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

/** The menu's rows below the agents, in the order they are drawn. */
const MENU_ACTIONS = ["agents", "ceiling", "save"] as const;
type MenuAction = (typeof MENU_ACTIONS)[number];

type Phase =
  | { kind: "rename"; index: number }
  /** Whether a recreated agent takes over the deleted one's configuration, one entry at a time. */
  | { kind: "recreated"; index: number }
  | { kind: "agents" }
  /** Which of the agents just marked are asked for work, offered from that answer. */
  | { kind: "pollers" }
  | { kind: "agent"; index: number; question: number }
  | { kind: "ceiling" }
  /** The menu itself: the agents, then the three rows below them. */
  | { kind: "menu"; cursor: number }
  /** One agent's rows, opened from the menu. `index` is into the answered agents. */
  | { kind: "rows"; index: number; cursor: number }
  /**
   * One row being edited with its walk question; Esc goes back to the rows.
   * `pending` is the agent with a choice made but not yet kept: switching to a
   * key is kept only once its variable has been named and judged, so Esc on
   * that second question leaves the agent as it was.
   */
  | { kind: "edit"; index: number; question: number; cursor: number; pending?: AgentAnswer }
  /** Whether the agent is asked for work, as a choice of two. */
  | { kind: "polls"; index: number; cursor: number }
  /** The limits screen: the budget, then the wall clock, both blank for none. */
  | { kind: "limits"; index: number; cursor: number; field: "budget" | "wallClock"; budget?: number | null }
  /** Esc at the top with unsaved changes: only `y` leaves. */
  | { kind: "leave" };

/**
 * Whether two id lists are the same selection, order disregarded.
 *
 * Order is the list's own and not an answer, so two spellings of one selection
 * must not read as a change: what this decides is whether an answer given about
 * the first list still covers the second.
 */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/** A Tab cycle in progress: what it was computed from, the matches, and where in them we are. */
interface Completion {
  matches: string[];
  index: number;
}

interface State {
  phase: Phase;
  /**
   * Whether this run is the first-run walk or the menu. Decided once, when the
   * questions that come before either have been answered, and it decides where
   * the shared steps go next: the walk moves on, the menu comes back.
   */
  mode: "walk" | "menu";
  /** Renamed entries the person chose NOT to keep — dropped, and reported as such. */
  dropped: RenamedEntry[];
  /** Recreated entries the person chose NOT to carry over — dropped, and reported as such. */
  notCarried: RecreatedEntry[];
  chosen: string[];
  /**
   * The chosen agents that will be asked for work — **null until that question
   * has been answered**, since marking nobody is an answer to it and an empty
   * list must not read as *not yet*.
   */
  pollers: string[] | null;
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
  /** The menu's agents as they were when *Add or remove agents…* was opened, which Esc there goes back to. */
  beforeList: { agents: AgentAnswer[]; chosen: string[]; pollers: string[] | null } | null;
}

/** The gutter colour: one rule down the left of every prompt, so no line reads as the shell's. */
const FRAME_COLOR = "cyan";

/** The parts of Ink's key this screen reads, for the menu's own keys. */
interface MenuKey {
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
}

/**
 * The screen. Calls `onDone` once with every answer, `onUnchanged` when the
 * menu is left with nothing changed, or `onDiscarded` when changes are left
 * unsaved with a `y`; none of them on Ctrl-C.
 */
function ConfigureScreen({
  plan,
  onDone,
  onUnchanged,
  onDiscarded,
}: {
  plan: ScreenPlan;
  onDone: (answers: Answers) => void;
  onUnchanged?: () => void;
  onDiscarded?: () => void;
}): ReactElement {
  const { exit } = useApp();

  const optionsById = new Map(plan.choices.options.map((o) => [o.value, o]));
  /** Configured entries whose agent was deleted: the menu names them and saving drops them. */
  const goneIds = new Set(plan.choices.disappeared.filter((d) => d.reason === GONE_FROM_ROSTER).map((d) => d.id));
  const existingById = new Map(Object.entries(plan.existing?.agents ?? {}).map(([name, entry]) => [entry.id, { name, entry }]));
  const nameOf = (id: string) => optionsById.get(id)?.name ?? existingById.get(id)?.name ?? id;
  const defaultsFor = (id: string): AgentDefaults =>
    agentDefaults(nameOf(id), existingById.get(id)?.entry ?? null, plan.currentDirectory, plan.draft?.agents[id] ?? null);

  const [state, setState] = useState<State>(() =>
    begin(
      {
        phase: { kind: "agents" },
        mode: "walk",
        dropped: [],
        notCarried: [],
        chosen: [],
        pollers: null,
        agents: [],
        current: null,
        // On presence and not on `??`: a draft's null is *the server's ceiling*,
        // an answer, and falling through it would put back the value it replaced.
        sessionsPerHour:
          plan.draft && plan.draft.sessionsPerHour !== undefined ? plan.draft.sessionsPerHour : (plan.existing?.sessionsPerHour ?? null),
        beforeList: null,
        problem: null,
        warning: null,
        offered: "",
        attempt: 0,
        typed: "",
        completion: null,
      },
      -1,
    ),
  );

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
  function offer(s: State, value: string): State {
    return { ...s, offered: value, typed: value, attempt: s.attempt + 1, completion: null };
  }

  /**
   * The step after rename question `index` (-1 for before the first): the next
   * rename, then the first carry-over, then — with those answered — the menu
   * when there is a config to show, or the walk's list when there is not.
   *
   * Both kinds are asked before anything else because both decide which agents
   * there are: an entry declined here is not on the list or the menu, and a
   * person should not have to undo a mark the program made after they had said
   * no.
   */
  function begin(s: State, index: number): State {
    if (index + 1 < plan.choices.renamed.length) return { ...s, phase: { kind: "rename", index: index + 1 } };
    if (plan.choices.recreated.length > 0) return { ...s, phase: { kind: "recreated", index: 0 } };
    return openMenu(s);
  }

  /**
   * The menu, seeded from the config, or the walk's list when there is nothing
   * to put on one.
   *
   * **Every configured entry is on it but the deleted ones**, which is the
   * walk's own rule: a deleted agent's keys went with it, so its entry can never
   * work, and keeping it would retry a mint for a dead id on every save. It is
   * not dropped in silence — the menu names it and counts its removal as a
   * change — and an entry that is merely no longer this account's to manage
   * stays, since its key still works.
   */
  function openMenu(s: State): State {
    if (plan.existing === null) return { ...s, mode: "walk", phase: { kind: "agents" } };
    const declined = new Set([...s.dropped.map((d) => d.id), ...s.notCarried.map((r) => r.id), ...goneIds]);
    const fromDraft = plan.draft && plan.draft.chosen.length > 0 ? plan.draft.chosen : null;
    const configured = Object.values(plan.existing.agents).map((entry) => entry.id);
    const chosen = (fromDraft ?? configured).filter((id) => !declined.has(id) && (optionsById.has(id) || existingById.has(id)));
    if (chosen.length === 0) return { ...s, mode: "walk", phase: { kind: "agents" } };
    const pollers = pollingChoices(chosen, plan.choices.options, plan.existing, plan.draft).preselected;
    // Only a configured entry goes straight onto the menu. One that only a draft
    // chose was being added when that run stopped, so it walks its own questions
    // first, as an agent added from the menu does: seeded from defaults, it would
    // be saved with whatever directory configure happened to start in.
    const agents = chosen
      .filter((id) => existingById.has(id))
      .map((id) => ({ name: nameOf(id), id, ...defaultsFor(id), pollsWork: pollers.includes(id) }));
    if (agents.length < chosen.length) {
      // Esc on those questions goes back to the menu the draft left, without
      // the agents it was still adding.
      const beforeList = { agents, chosen: agents.map((a) => a.id), pollers: pollers.filter((id) => existingById.has(id)) };
      const walking: State = { ...s, mode: "menu", chosen, pollers, agents, beforeList };
      return startAgent(walking, nextToWalk(walking, 0)!);
    }
    // `mdbrain agents` names an entry by the id in the file, and a carried-over
    // entry's id has already moved to the new agent's here, so the old id is
    // followed to where it went.
    const openAt = plan.choices.recreated.find((r) => r.previousId === plan.openAt)?.id ?? plan.openAt;
    const at = openAt === undefined ? -1 : agents.findIndex((a) => a.id === openAt);
    const phase: Phase = at === -1 ? { kind: "menu", cursor: 0 } : { kind: "rows", index: at, cursor: 0 };
    return { ...s, mode: "menu", chosen, pollers, agents, phase };
  }

  /** The agents set to `agents`, with the pollers list kept in step, so the draft records what the menu shows. */
  function withAgents(s: State, agents: AgentAnswer[]): State {
    return { ...s, agents, chosen: agents.map((a) => a.id), pollers: agents.filter((a) => a.pollsWork).map((a) => a.id) };
  }

  /** The next chosen agent, after `from`, that has not been answered yet — or null. */
  function nextToWalk(s: State, from: number): number | null {
    const answered = new Set(s.agents.map((a) => a.id));
    for (let i = from; i < s.chosen.length; i += 1) if (!answered.has(s.chosen[i])) return i;
    return null;
  }

  function startAgent(s: State, index: number): State {
    // The list's answer overwrites the entry's own starting value, because the
    // list is where it was just decided: an agent that was a poller last time
    // and was unmarked a moment ago must be asked this run's questions, not last
    // run's.
    const defaults = { ...defaultsFor(s.chosen[index]), pollsWork: (s.pollers ?? s.chosen).includes(s.chosen[index]) };
    const first = AGENT_QUESTIONS[0].skip?.(defaults) ? nextQuestion(defaults, 0) : 0;
    // Every question is skippable in principle; a per-agent block with none left
    // would be a table nobody could answer, so it is treated as done rather than
    // crashed.
    if (first === null) return afterAgent(s, index, defaults);
    return offer(
      { ...s, phase: { kind: "agent", index, question: first }, current: defaults, problem: null, warning: null },
      readOf(AGENT_QUESTIONS[first], defaults),
    );
  }

  /**
   * The step after an agent's last question: the next agent still to be asked
   * about, and then — on the walk — the ceiling, or — from the menu — the menu
   * again, with the agents in the list's order.
   */
  function afterAgent(s: State, index: number, current: AgentDefaults): State {
    const id = s.chosen[index];
    const agents = [...s.agents, { name: nameOf(id), id, ...current }];
    const next = { ...s, agents, current: null, problem: null };
    const following = nextToWalk(next, index + 1);
    if (following !== null) return startAgent(next, following);
    if (s.mode === "menu") return afterAgentsChanged(next);
    return offer({ ...next, phase: { kind: "ceiling" } }, next.sessionsPerHour === null ? "" : String(next.sessionsPerHour));
  }

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

  /** One agent's answers replaced, and the menu back at that agent's rows. */
  const replaceAgent = (s: State, index: number, cursor: number, agent: AgentAnswer, warning: string | null = null): State => {
    const agents = s.agents.map((a, i) => (i === index ? agent : a));
    return { ...withAgents(s, agents), phase: { kind: "rows", index, cursor }, problem: null, warning };
  };

  /** Open one row of an agent: its walk question, the polls choice, or the limits screen. */
  const openRow = (s: State, index: number, cursor: number) => {
    const agent = s.agents[index];
    const row = agentRows(agent)[cursor];
    if (!row) return;
    const cleared = { ...s, problem: null, warning: null };
    if (row.kind === "polls") return setState({ ...cleared, phase: { kind: "polls", index, cursor } });
    if (row.kind === "limits") {
      const budget = agent.limits.maxBudgetUsd;
      return setState(offer({ ...cleared, phase: { kind: "limits", index, cursor, field: "budget" } }, budget === undefined ? "" : String(budget)));
    }
    const question = QUESTION_FOR_ROW[row.kind]!;
    setState(offer({ ...cleared, phase: { kind: "edit", index, question, cursor } }, readOf(AGENT_QUESTIONS[question], agent)));
  };

  const editText = (raw: string) => {
    if (state.phase.kind !== "edit") return;
    const { index, question, cursor } = state.phase;
    const q = AGENT_QUESTIONS[question];
    if (q.kind !== "text") return;
    const judged = q.judge(raw, plan);
    if (!judged.ok) {
      setState(offer({ ...state, problem: judged.problem, warning: null }, raw));
      return;
    }
    const agent = state.phase.pending ?? state.agents[index];
    advance(replaceAgent(state, index, cursor, { ...agent, ...q.write(agent, judged.value) }, judged.warning ?? null));
  };

  const editChoice = (value: string) => {
    if (state.phase.kind !== "edit") return;
    const { index, question, cursor } = state.phase;
    const q = AGENT_QUESTIONS[question];
    if (q.kind !== "choice") return;
    const agent = state.agents[index];
    const written = { ...agent, ...q.write(agent, value) };
    // Choosing a key where there was the account goes straight on to naming the
    // variable, the step the walk takes after the same answer: the row that
    // names it did not exist a moment ago. The switch is held, not kept, until
    // the variable is answered, so the variable's judge always runs on what is
    // saved and Esc means what its footer says.
    if (question === HARNESS_QUESTION && agent.harnessVariable === null && written.harnessVariable !== null) {
      const phase: Phase = { kind: "edit", index, question: VARIABLE_QUESTION, cursor: cursor + 1, pending: written };
      setState(offer({ ...state, phase, problem: null, warning: null }, readOf(AGENT_QUESTIONS[VARIABLE_QUESTION], written)));
      return;
    }
    advance(replaceAgent(state, index, cursor, written));
  };

  const editLimit = (raw: string) => {
    if (state.phase.kind !== "limits") return;
    const phase = state.phase;
    const agent = state.agents[phase.index];
    if (phase.field === "budget") {
      const judged = judgeBudget(raw);
      if (!judged.ok) return setState(offer({ ...state, problem: judged.problem }, raw));
      const wall = agent.limits.wallClock;
      setState(offer({ ...state, problem: null, phase: { ...phase, field: "wallClock", budget: judged.value } }, wall ?? ""));
      return;
    }
    const judged = judgeDuration(raw);
    if (!judged.ok) return setState(offer({ ...state, problem: judged.problem }, raw));
    const limits: Limits = {};
    if (phase.budget !== null && phase.budget !== undefined) limits.maxBudgetUsd = phase.budget;
    if (judged.value !== null) limits.wallClock = judged.value;
    advance(replaceAgent(state, phase.index, phase.cursor, { ...agent, limits }));
  };

  /** The answers as they stand, which is what *Save and leave* hands back. */
  const answersOf = (s: State): Answers => ({ agents: s.agents, sessionsPerHour: s.sessionsPerHour, dropped: s.dropped, notCarried: s.notCarried });

  /**
   * What saving would change. A carry-over is one change the comparison cannot
   * see, since the screen reads the config with the new id already in place.
   */
  const changes = (s: State): number => {
    const carried = plan.choices.recreated.filter((r) => !s.notCarried.some((n) => n.id === r.id) && s.agents.some((a) => a.id === r.id)).length;
    return countChanges(plan.existing, assembleConfig(answersOf(s))) + carried + (plan.pending ?? 0);
  };

  const menuLength = state.agents.length + MENU_ACTIONS.length;

  /**
   * Back to the menu from inside *Add or remove agents…*, as it was before it was
   * opened — unless that menu held no agents, when Esc lands on the list instead.
   *
   * Only a restarted draft can leave such a menu behind: one whose agents
   * replaced every configured one, each still being walked. A menu with nothing
   * on it would let *Save and leave* write a config every command refuses, and
   * every other way to zero agents is refused too, so the list is held until one
   * is marked, with the draft's marks still on it.
   */
  const abandonList = (s: State): State => {
    const before = s.beforeList ?? { agents: s.agents, chosen: s.chosen, pollers: s.pollers };
    if (before.agents.length === 0) {
      const none = judgeSelection([], plan.choices.options);
      return { ...s, agents: [], current: null, phase: { kind: "agents" }, problem: none.ok ? null : none.problem, warning: null };
    }
    return { ...s, ...before, beforeList: null, current: null, phase: { kind: "menu", cursor: before.agents.length }, problem: null, warning: null };
  };

  const onMenuKey = (input: string, key: MenuKey) => {
    const { phase } = state;
    if (phase.kind === "leave") {
      // Only `y` leaves, and every other key stays — the rule `mdbrain agents`
      // has for every question it asks.
      if (input === "y" && !key.ctrl) {
        onDiscarded?.();
        exit();
      } else setState({ ...state, phase: { kind: "menu", cursor: menuLength - 1 } });
      return;
    }
    // The list, the pollers and a new agent's questions are one step taken
    // from the menu, so Esc in any of them goes back to the menu as it was.
    if (phase.kind === "agents" || phase.kind === "pollers" || phase.kind === "agent") {
      if (key.escape) advance(abandonList(state));
      return;
    }
    if (phase.kind === "menu") {
      if (key.upArrow) return setState({ ...state, phase: { kind: "menu", cursor: Math.max(0, phase.cursor - 1) } });
      if (key.downArrow) return setState({ ...state, phase: { kind: "menu", cursor: Math.min(menuLength - 1, phase.cursor + 1) } });
      if (key.escape) {
        if (changes(state) > 0) return setState({ ...state, phase: { kind: "leave" } });
        onUnchanged?.();
        return exit();
      }
      if (!key.return) return;
      if (phase.cursor < state.agents.length) return setState({ ...state, phase: { kind: "rows", index: phase.cursor, cursor: 0 }, problem: null, warning: null });
      const action: MenuAction = MENU_ACTIONS[phase.cursor - state.agents.length];
      if (action === "agents") {
        const beforeList = { agents: state.agents, chosen: state.chosen, pollers: state.pollers };
        return setState({ ...state, beforeList, phase: { kind: "agents" }, problem: null, warning: null });
      }
      if (action === "ceiling") {
        return setState(offer({ ...state, phase: { kind: "ceiling" }, problem: null, warning: null }, state.sessionsPerHour === null ? "" : String(state.sessionsPerHour)));
      }
      onDone(answersOf(state));
      return exit();
    }
    if (phase.kind === "rows") {
      const rows = agentRows(state.agents[phase.index]);
      if (key.upArrow) return setState({ ...state, phase: { ...phase, cursor: Math.max(0, phase.cursor - 1) } });
      if (key.downArrow) return setState({ ...state, phase: { ...phase, cursor: Math.min(rows.length - 1, phase.cursor + 1) } });
      if (key.escape) return setState({ ...state, phase: { kind: "menu", cursor: phase.index }, problem: null, warning: null });
      if (key.return) openRow(state, phase.index, phase.cursor);
      return;
    }
    // Inside a field or a choice, only Esc is read here: it goes back to the
    // agent's rows — or, for the ceiling, to the menu — and keeps nothing typed.
    if (!key.escape) return;
    if (phase.kind === "edit" || phase.kind === "polls" || phase.kind === "limits") {
      // A held switch was never kept, so the variable's row it would have added
      // is not there to go back to; the cursor returns to *Pays with*.
      const cursor = phase.kind === "edit" && phase.pending ? phase.cursor - 1 : phase.cursor;
      setState({ ...state, phase: { kind: "rows", index: phase.index, cursor }, problem: null, warning: null });
    } else if (phase.kind === "ceiling") {
      setState({ ...state, phase: { kind: "menu", cursor: state.agents.length + 1 }, problem: null, warning: null });
    }
  };

  const menuKeysActive =
    state.mode === "menu" &&
    ["menu", "rows", "edit", "polls", "limits", "leave", "ceiling", "agents", "pollers", "agent"].includes(state.phase.kind);
  useInput(onMenuKey, { isActive: menuKeysActive });

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
    for (const a of s.agents) agents[a.id] = { id: a.id, cwd: a.cwd, harnessVariable: a.harnessVariable, limits: a.limits };
    if (s.phase.kind === "agent" && s.current) {
      const id = s.chosen[s.phase.index];
      agents[id] = { id, cwd: s.current.cwd, harnessVariable: s.current.harnessVariable, limits: s.current.limits };
    }
    const draft: ConfigureDraft = {
      version: DRAFT_VERSION,
      chosen: s.chosen.length > 0 ? s.chosen : (plan.draft?.chosen ?? []),
      agents,
      dropped: [...s.dropped.map((d) => d.id), ...s.notCarried.map((r) => r.id)],
      sessionsPerHour: s.sessionsPerHour,
    };
    // Laid over the earlier draft the same way the agents are: this run has no
    // answer to the question until it has been asked, and writing one it does
    // not have would erase the answer a previous run left.
    //
    // **Only while the selection it answered is still the selection**, because
    // `chosen` is the only record of which agents the answer was given about. A
    // widened list recorded beside an older answer tells the next run that agent
    // was asked and said no, and it would be written `pollsWork: false` with
    // nobody having unmarked it — the outcome this question must not produce in
    // silence. Where the list has changed and this run has not reached the
    // question, there is no answer to record: the next run marks from the config
    // and then from everybody, which is the direction that cannot withhold work.
    const carried = sameIds(draft.chosen, plan.draft?.chosen ?? []) ? plan.draft?.pollers : undefined;
    const pollers = s.pollers ?? carried;
    if (pollers) draft.pollers = pollers;
    return draft;
  };

  const { phase } = state;
  const editing = phase.kind === "agent" || phase.kind === "edit" ? AGENT_QUESTIONS[phase.question] : null;
  const completes = editing?.kind === "text" && editing.completes === true;

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
      advance(begin({ ...state, dropped: keep ? state.dropped : [...state.dropped, rename] }, phase.index));
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
  } else if (phase.kind === "recreated") {
    const recreated = plan.choices.recreated[phase.index];
    const answerCarry = (carry: boolean) => {
      const nextIndex = phase.index + 1;
      const next = { ...state, notCarried: carry ? state.notCarried : [...state.notCarried, recreated] };
      advance(nextIndex < plan.choices.recreated.length ? { ...next, phase: { kind: "recreated", index: nextIndex } } : openMenu(next));
    };
    question = h(
      Box,
      { flexDirection: "column" },
      h(
        Text,
        null,
        `${recreated.name} was deleted and created again in markdownbrain.ai. Carry this machine's configuration over to the new one? `,
      ),
      h(
        Text,
        { dimColor: true },
        "Its directory, harness and limits are kept and a new connection key is requested, since the deleted agent's keys went with it. Answering no drops the entry.",
      ),
      h(ConfirmInput, {
        key: `recreated-${phase.index}`,
        defaultChoice: plan.draft?.dropped.includes(recreated.id) ? "cancel" : "confirm",
        onConfirm: () => answerCarry(true),
        onCancel: () => answerCarry(false),
      }),
    );
  } else if (phase.kind === "agents") {
    const droppedIds = new Set([...state.dropped.map((d) => d.id), ...state.notCarried.map((r) => r.id)]);
    // From the menu, the list arrives marked with what the menu holds. On the
    // walk, a draft's marks are the person's most recent answer to this same
    // question, so they stand ahead of the config's — but only when there is a
    // draft, since an empty list from one that never reached this question would
    // unmark everything the config had.
    const marked =
      state.mode === "menu" ? state.chosen : plan.draft && plan.draft.chosen.length > 0 ? plan.draft.chosen : plan.choices.preselected;
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
          // From the menu the agents already answered stay answered, in the
          // list's new order; only the ones just added are walked.
          else if (state.mode === "menu") {
            const kept = state.agents.filter((a) => judged.value.includes(a.id));
            advance({ ...state, chosen: judged.value, agents: kept, phase: { kind: "pollers" }, problem: null });
          } else advance({ ...state, chosen: judged.value, phase: { kind: "pollers" }, problem: null });
        },
      }),
    );
  } else if (phase.kind === "pollers") {
    // From the menu, what the menu says an agent does is the answer most
    // recently given about it, so it is what the list arrives marked with.
    const menuPollers = new Map(state.agents.map((a) => [a.id, a.pollsWork]));
    const polling = pollingChoices(state.chosen, plan.choices.options, plan.existing, plan.draft);
    const preselected =
      state.mode === "menu"
        ? polling.options.filter((o) => menuPollers.get(o.value) ?? polling.preselected.includes(o.value)).map((o) => o.value)
        : polling.preselected;
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Which of them poll for work? Space unmarks one to keep its identity here without mdbrain run ever asking for its work."),
      h(Text, { dimColor: true }, "An unmarked agent is still configured: mdbrain as <agent> starts a session as it."),
      h(MultiSelect, {
        // Keyed by the selection it was offered from, so going back to the list
        // and marking a different set remounts the component rather than leaving
        // it showing the previous answer's rows.
        key: `pollers-${state.chosen.join(",")}`,
        options: polling.options,
        defaultValue: preselected,
        visibleOptionCount: Math.min(12, Math.max(1, polling.options.length)),
        // Marking nobody is a legal answer and is not judged here: `run` says
        // what it means, once, where it is the thing that cannot happen.
        onSubmit: (values: string[]) => {
          const answered = { ...state, pollers: values, problem: null };
          if (state.mode === "menu") {
            const withPolls = { ...answered, agents: state.agents.map((a) => ({ ...a, pollsWork: values.includes(a.id) })) };
            const following = nextToWalk(withPolls, 0);
            return advance(following === null ? afterAgentsChanged(withPolls) : startAgent(withPolls, following));
          }
          advance(startAgent(answered, 0));
        },
      }),
    );
  } else if (phase.kind === "agent") {
    const name = nameOf(state.chosen[phase.index]);
    const q = AGENT_QUESTIONS[phase.question];
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, state.mode === "menu" ? `${name} (new agent)` : `${name} (${phase.index + 1} of ${state.chosen.length})`),
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
  } else if (phase.kind === "menu" || phase.kind === "leave") {
    const count = changes(state);
    const ceiling = state.sessionsPerHour === null ? `server's ceiling (${SESSION_CAP_HARD_MAX})` : `${state.sessionsPerHour}`;
    const actions: Array<[string, string]> = [
      ["Add or remove agents…", ""],
      ["Sessions an hour", ceiling],
      ["Save and leave", changesLabel(count)],
    ];
    // One column for the names and the labels both, so every value starts at
    // the same place whichever of the two is longer.
    const width = Math.max(...state.agents.map((a) => a.name.length), ...actions.map(([label]) => label.length));
    const pointer = (i: number) => (phase.kind === "menu" && phase.cursor === i ? "›" : " ");
    const rows: ReactElement[] = state.agents.map((a, i) =>
      h(Text, { key: `a-${a.id}`, bold: phase.kind === "menu" && phase.cursor === i }, `${pointer(i)} ${a.name.padEnd(width)}  ${agentSummary(a)}`),
    );
    for (const gone of plan.choices.disappeared.filter((d) => goneIds.has(d.id))) {
      rows.push(h(Text, { key: `gone-${gone.id}`, dimColor: true }, `  ${gone.name} is ${gone.reason}, so saving drops it.`));
    }
    rows.push(h(Text, { key: "rule", dimColor: true }, "  ─"));
    const base = state.agents.length;
    actions.forEach(([label, value], j) => {
      const i = base + j;
      rows.push(h(Text, { key: `m-${j}`, bold: phase.kind === "menu" && phase.cursor === i }, `${pointer(i)} ${label.padEnd(width)}  ${value}`.trimEnd()));
    });
    question = h(
      Box,
      { flexDirection: "column" },
      ...rows,
      phase.kind === "leave"
        ? h(Text, { key: "leave", bold: true }, `Leave without saving ${changesLabel(count)}? y to leave, any other key to stay.`)
        : h(Text, { key: "keys", dimColor: true }, "↑/↓ move · Enter opens · Esc leaves"),
    );
  } else if (phase.kind === "rows") {
    const agent = state.agents[phase.index];
    const rows = agentRows(agent);
    const width = Math.max(...rows.map((r) => r.label.length));
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, agent.name),
      ...rows.map((row, i) =>
        h(Text, { key: row.kind, bold: phase.cursor === i }, `${phase.cursor === i ? "›" : " "} ${row.label.padEnd(width)}  ${row.value}`),
      ),
      h(Text, { key: "keys", dimColor: true }, "↑/↓ move · Enter edits · Esc back to the menu"),
    );
  } else if (phase.kind === "edit") {
    const agent = phase.pending ?? state.agents[phase.index];
    const q = AGENT_QUESTIONS[phase.question];
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, agent.name),
      h(Text, null, q.prompt(agent.name)),
      ...(q.hint ? [h(Text, { key: "hint", dimColor: true }, q.hint)] : []),
      q.kind === "choice"
        ? h(Select, { key: `edit-choice-${phase.index}-${phase.question}`, options: q.options(agent), onChange: editChoice })
        : field(`edit-${phase.index}-${phase.question}-${state.attempt}`, state, onTyped, editText),
      h(Text, { key: "keys", dimColor: true }, "Esc goes back without changing it"),
    );
  } else if (phase.kind === "polls") {
    const agent = state.agents[phase.index];
    const yes = { label: "yes: mdbrain run asks for its work", value: "yes" };
    const no = { label: "no: identity only, for mdbrain as", value: "no" };
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, agent.name),
      h(Text, null, `Does mdbrain run ask for ${agent.name}'s work?`),
      h(Select, {
        key: `polls-${phase.index}`,
        options: agent.pollsWork ? [yes, no] : [no, yes],
        onChange: (value: string) => advance(replaceAgent(state, phase.index, phase.cursor, { ...agent, pollsWork: value === "yes" })),
      }),
      h(Text, { key: "keys", dimColor: true }, "Esc goes back without changing it"),
    );
  } else if (phase.kind === "limits") {
    const agent = state.agents[phase.index];
    const prompt =
      phase.field === "budget"
        ? `Most dollars a session of ${agent.name} may spend. Blank for none.`
        : `Longest a session of ${agent.name} may run, with a unit (2h, 90m). Blank for none.`;
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, { bold: true }, `${agent.name}: limits`),
      h(Text, { dimColor: true }, `A session with no limit runs until it finishes; mdbrain run notes one that passes ${NO_LIMIT_NOTE_MS / 3_600_000}h with no time limit.`),
      h(Text, null, prompt),
      field(`limits-${phase.field}-${state.attempt}`, state, onTyped, editLimit),
      h(Text, { key: "keys", dimColor: true }, "Esc goes back without changing them"),
    );
  } else {
    // The ceiling: the last question of the walk, so a good answer there
    // finishes; from the menu, a row like any other, so it goes back.
    question = h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Most sessions an hour this machine starts per agent. Blank keeps the server's ceiling of 10; a brain may lower it, never raise it."),
      field(`ceiling-${state.attempt}`, state, onTyped, (raw: string) => {
        const judged = judgeCeiling(raw);
        if (!judged.ok) setState(offer({ ...state, problem: judged.problem }, raw));
        else if (state.mode === "menu") {
          advance({ ...state, sessionsPerHour: judged.value, phase: { kind: "menu", cursor: state.agents.length + 1 }, problem: null, warning: null });
        } else {
          // Recorded before the screen goes, so a write that fails leaves a draft
          // holding every answer rather than one short of the last.
          advance({ ...state, sessionsPerHour: judged.value, problem: null, warning: null });
          onDone({ agents: state.agents, sessionsPerHour: judged.value, dropped: state.dropped, notCarried: state.notCarried });
          exit();
        }
      }),
    );
  }

  /** Back to the menu after the agent list changed, with every agent answered, in the list's order. */
  function afterAgentsChanged(s: State): State {
    const order = new Map(s.chosen.map((c, i) => [c, i]));
    const sorted = [...s.agents].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return { ...withAgents(s, sorted), phase: { kind: "menu", cursor: 0 } };
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
export function configureScreen(
  plan: ScreenPlan,
  onDone: (answers: Answers) => void,
  onUnchanged?: () => void,
  onDiscarded?: () => void,
): ReactElement {
  return h(ConfigureScreen, { plan, onDone, ...(onUnchanged ? { onUnchanged } : {}), ...(onDiscarded ? { onDiscarded } : {}) });
}

/**
 * What the screen ended with: every answer; `unchanged` for a menu left with
 * nothing changed; `discarded` for changes a person chose to leave unsaved,
 * which the command forgets rather than offering again; or null when the person
 * left before the end with Ctrl-C, whose answers the draft keeps.
 */
export type ScreenResult = Answers | "unchanged" | "discarded" | null;

/** Draws the screen on the real terminal and answers with how it ended. */
export async function askOnScreen(plan: ScreenPlan): Promise<ScreenResult> {
  let result: ScreenResult = null;
  const app = render(
    configureScreen(
      plan,
      (a) => { result = a; },
      () => { result = "unchanged"; },
      () => { result = "discarded"; },
    ),
    { exitOnCtrlC: true },
  );
  await app.waitUntilExit();
  return result;
}
