// The configure sequence as a decision: what each step offers, how an answer is
// judged, what a disappeared or renamed entry becomes, and what the finished
// answers write.
//
// Kept apart from the screen that asks, because the screen is the replaceable
// half. Every rule here is testable with plain values, and the screen only
// renders one step at a time and hands the answer back — so a different
// renderer asks exactly the same questions, in the same order, judged the same
// way, or it is not this command.
//
// Four rules of judgement worth stating. **Only agents this account may manage
// are offered**: the right that governs adding and deleting an agent in the app
// is the right that governs appearing in this picker, and it is also what
// decides whether the server will mint the agent a key — so an agent that
// cannot be run is not on the list, and the ones left out are counted out loud
// rather than silently dropped. **A credential variable that is not
// set in this shell is warned about, not refused**: it may well be set in the
// shell `run` is started from, and refusing would force the two commands to
// share a shell. **A configured agent the roster no longer holds is kept and
// marked, never dropped silently**: a dropped entry is indistinguishable from
// one never configured, so anything that does drop one says so. And **two
// agents with one display name cannot both be run here**: the file is keyed by
// name because the claim request matches by name, so a second agent of the
// same name would either overwrite the first or receive its work.
//
// **Which agents this machine runs and which of them poll for work are two
// questions, asked in that order.** The first says whose identity this machine
// holds — a key, a connection file, a checkout — and the second says which of
// those the runner may take work as. They were one question for as long as there
// was only one thing to do with an identity; `mdbrain as` is what separated
// them, and the second list is offered from the first's answer so a poller can
// only ever be an agent already chosen. Nothing here refuses an empty second
// list: a machine whose agents are all driven by hand is a configuration, and
// `run` is where that is worth a sentence rather than here.

import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import type { Agent, Membership, Organization } from "../auth/api.ts";
import {
  CONFIG_VERSION,
  DEFAULT_BOUNDS,
  SESSION_CAP_HARD_MAX,
  durationMs,
  isVariableName,
  looksLikeSecret,
  newAgentMap,
  type AgentEntry,
  type Bounds,
  type Config,
} from "../config/schema.ts";

/** The variable the one harness reads its own credential from. */
export const HARNESS_CREDENTIAL_VARIABLE = "ANTHROPIC_API_KEY";

/** One agent as the roster describes it, with its organization named. */
export interface RosterAgent {
  id: string;
  name: string;
  organization: string;
  status: string;
}

/**
 * The organizations this account may manage agents in.
 *
 * *Manage* is one right, not two: adding an agent, deleting one, and minting its
 * connection key are all `assert_agent_org_owner`, so ownership of the
 * organization is the whole of the question. It is asked here rather than
 * inferred from what the roster returns, because an ordinary member can read
 * every agent in an organization and change none of them.
 */
export function ownedOrganizations(organizations: Organization[], memberships: Membership[]): Organization[] {
  const owned = new Set(memberships.filter((m) => m.role === "owner").map((m) => m.org_id));
  return organizations.filter((o) => owned.has(o.id));
}

/**
 * The roster as the screen offers it: one line per agent, organizations named.
 *
 * **Ordered by organization, then by name within it.** The read's own order is
 * whatever the server returned, which is an accident rather than a decision and
 * makes a list of any length hard to scan; grouping is what a person is looking
 * for when they ask which agents this machine runs. Digits compare as numbers,
 * so `bot-2` sorts before `bot-10`.
 *
 * **An agent whose organization is not in `organizations` is not offered.** Pass
 * the owned organizations and the list is exactly the agents this account may
 * manage — which is the same list the app's settings would let it change, and
 * the same one the server will mint a key for. Offering more would be offering
 * agents that cannot be run.
 */
export function rosterAgents(organizations: Organization[], agents: Agent[]): RosterAgent[] {
  const orgName = new Map(organizations.map((o) => [o.id, o.name]));
  return agents
    .filter((a) => orgName.has(a.org_id))
    .map((a) => ({
      id: a.id,
      name: a.display_name,
      organization: orgName.get(a.org_id)!,
      status: a.status,
    }))
    .sort((a, b) => compareNames(a.organization, b.organization) || compareNames(a.name, b.name));
}

/** One ordering for every list here: case-insensitive, and digits as numbers. */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * The organizations offered that hold no agent at all — an answer worth showing,
 * since a list that simply omits them would make an empty organization
 * indistinguishable from not being a member of it.
 */
export function organizationsWithoutAgents(organizations: Organization[], agents: Agent[]): string[] {
  const withAgents = new Set(agents.map((a) => a.org_id));
  return organizations
    .filter((o) => !withAgents.has(o.id))
    .map((o) => o.name)
    .sort(compareNames);
}

/**
 * The sentence naming agents the account can see but not manage, or null when
 * there are none.
 *
 * The filter above is a silence otherwise, and in a list somebody is choosing
 * from that is the one thing it must not be: an agent missing because it
 * belongs to somebody else's organization looks exactly like an agent that does
 * not exist, and the person is here precisely to find it.
 *
 * **The picker is the only caller, and `whoami` deliberately is not.** The same
 * filter runs there, but that command answers which agents this machine may
 * run, and a count of the ones it may not is an answer to a question nobody
 * asked. Two surfaces over one filter are allowed to say different amounts
 * about it; what they may not do is list different agents.
 *
 * It takes the count already worked out rather than the two totals to subtract,
 * so the subtraction stays with the caller that knows which two numbers it
 * means.
 */
export function withheldAgentsLine(withheld: number): string | null {
  if (withheld < 1) return null;
  return withheld === 1
    ? "One agent is not shown here: it is in an organization you do not own, so you cannot run it."
    : `${withheld} agents are not shown here: they are in organizations you do not own, so you cannot run them.`;
}

/**
 * The sentence for an account that owns no organization, and so has no agent it
 * may run.
 *
 * Shared by the picker and by `whoami` deliberately: they are the same fact
 * reached by the same right, and two wordings of it would let one command tell
 * somebody their account is fine while the other tells them it is not.
 */
export const NOTHING_TO_MANAGE =
  "No agents here belong to an organization you own, so there is none this machine may run. Agents are added and removed by an organization's owner, and the same right decides what these commands show.";

/** One line of the agent list. `value` is the agent's id, which is what survives a rename. */
export interface AgentOption {
  value: string;
  label: string;
  /** The name the entry is written under: the roster's, or the configured one for a disappeared entry. */
  name: string;
}

/** A configured entry the offered roster no longer holds under that id, and why. */
export interface DisappearedEntry {
  name: string;
  id: string;
  /** What is said about it: gone from the roster, or still there but no longer this account's to manage. */
  reason: string;
}

/** A configured entry whose id the roster holds under a different name. */
export interface RenamedEntry {
  from: string;
  to: string;
  id: string;
}

/** What the first question offers. */
export interface AgentChoices {
  options: AgentOption[];
  /** The ids marked on arrival — every entry the existing config has. */
  preselected: string[];
  disappeared: DisappearedEntry[];
  renamed: RenamedEntry[];
}

/**
 * The agent list, from the live roster and whatever is configured already.
 *
 * A disappeared entry is still offered — labelled as such, and marked — so the
 * person deselects it or keeps it. A renamed entry is offered under its new
 * name, since the request matches by name and an entry under the old one would
 * ask for nobody's work and receive none.
 */
export function agentChoices(roster: RosterAgent[], existing: Config | null, stillVisible: Set<string> = new Set()): AgentChoices {
  const byId = new Map(roster.map((a) => [a.id, a]));
  const options: AgentOption[] = roster.map((a) => ({
    value: a.id,
    name: a.name,
    label: `${a.organization} / ${a.name}${a.status === "active" ? "" : ` (${a.status})`}`,
  }));
  const preselected: string[] = [];
  const disappeared: DisappearedEntry[] = [];
  const renamed: RenamedEntry[] = [];
  for (const [name, entry] of Object.entries(existing?.agents ?? {})) {
    preselected.push(entry.id);
    const live = byId.get(entry.id);
    if (!live) {
      // Two different absences, and telling them apart matters: an agent this
      // account can still see but no longer owns has not been deleted, and
      // saying "no longer in the roster" about it would be a lie a person might
      // act on. The entry is kept and marked either way — its key still works
      // until somebody revokes it — but it is marked for the right reason.
      const reason = stillVisible.has(entry.id) ? "no longer an agent you manage" : "no longer in the roster";
      disappeared.push({ name, id: entry.id, reason });
      options.push({ value: entry.id, name, label: `${name} — ${reason}` });
    } else if (live.name !== name) {
      renamed.push({ from: name, to: live.name, id: entry.id });
    }
  }
  return { options, preselected, disappeared, renamed };
}

/**
 * Whether a selection can be written at all.
 *
 * Three collisions, all of them the same shape: a name is folded to something
 * shorter, and two names can fold to one. The file is keyed by display name, so
 * two chosen agents with one name — the same name in two organizations, say —
 * cannot both be entries. The MCP file each agent gets is named by folding its
 * name, so two names that fold to one file cannot both be written. And the
 * connection key's variable is folded harder still (`[^A-Z0-9]+` rather than
 * `[^a-z0-9._-]+`), so `bot.one` and `bot-one` get two different files that both
 * say `Bearer ${MDBRAIN_KEY_BOT_ONE}` — which is one agent authenticating as the
 * other, and the worst of the three. **That variable is derived rather than
 * asked**, so nothing downstream will catch it; it is caught here.
 *
 * All three are refused before any question is asked about either agent, naming
 * the pair.
 */
export function judgeSelection(chosen: string[], options: AgentOption[]): Judgement<string[]> {
  if (chosen.length === 0) return { ok: false, problem: "Pick at least one agent — space marks a row, Enter confirms." };
  const byId = new Map(options.map((o) => [o.value, o]));
  const seenName = new Map<string, string>();
  const seenFile = new Map<string, string>();
  const seenVariable = new Map<string, string>();
  for (const id of chosen) {
    const option = byId.get(id);
    if (!option) continue;
    const other = seenName.get(option.name);
    if (other) {
      return { ok: false, problem: `Two of the marked agents are both called ${option.name}. Work is matched by name, so this machine can run only one of them.` };
    }
    seenName.set(option.name, id);
    const file = mcpFileNameFor(option.name);
    const clash = seenFile.get(file);
    if (clash) {
      return { ok: false, problem: `${clash} and ${option.name} would share one connection file (${file}); pick one of them here.` };
    }
    seenFile.set(file, option.name);
    const variable = connectionKeyVariableFor(option.name);
    const sharing = seenVariable.get(variable);
    if (sharing) {
      return {
        ok: false,
        problem: `${sharing} and ${option.name} would both take their connection key from ${variable}, so one would run as the other; pick one of them here.`,
      };
    }
    seenVariable.set(variable, option.name);
  }
  return { ok: true, value: chosen };
}

/** What the second question offers: the agents just chosen, and which of them are marked. */
export interface PollingChoices {
  options: AgentOption[];
  /** The ids marked on arrival — the agents that would poll if the answer were Enter. */
  preselected: string[];
}

/**
 * Which of the chosen agents are offered as pollers, and which arrive marked.
 *
 * Offered from the first answer rather than from the roster, in the first
 * answer's own order, so the two lists read as one decision taken in two steps
 * and a poller cannot be an agent this machine does not hold.
 *
 * **Three sources for the marks, most recent first**, which is `agentDefaults`'
 * rule applied to a list-level answer: a draft that reached this question **and
 * was asked about this agent**, then the existing config, then *everything*. The
 * last is what makes this question free to add — a person who has never heard of
 * it answers Enter and gets the behaviour they already had. **An agent the config
 * does not know is marked**, for the same reason: a newly chosen agent is one
 * somebody just added to the machine, and adding an agent has always meant
 * adding a worker.
 */
export function pollingChoices(
  chosen: readonly string[],
  options: readonly AgentOption[],
  existing: Config | null,
  draft: ConfigureDraft | null = null,
): PollingChoices {
  const byId = new Map(options.map((o) => [o.value, o]));
  const offered = chosen
    .map((id) => byId.get(id))
    .filter((o): o is AgentOption => o !== undefined);
  const entryById = new Map(Object.values(existing?.agents ?? {}).map((entry) => [entry.id, entry]));
  // `undefined` is *this draft never reached the question* and `[]` is *it did,
  // and the answer was nobody* — the same distinction `harnessVariable` makes,
  // and load-bearing for the same reason: treating the second as the first would
  // re-mark every agent a person had just unmarked.
  //
  // **And the draft only answers for the agents it was itself asked about.** A
  // draft is a previous run's answers, and a run that marks an agent the previous
  // one did not was never asked whether that agent polls — so reading its absence
  // from `pollers` as *no* would write `pollsWork: false` for an agent nobody
  // unmarked, which is the one outcome this question must not produce silently.
  const answered = draft?.pollers;
  const asked = new Set(draft?.chosen ?? []);
  const preselected = offered
    .filter((o) => (answered && asked.has(o.value) ? answered.includes(o.value) : (entryById.get(o.value)?.pollsWork ?? true)))
    .map((o) => o.value);
  return { options: offered, preselected };
}

/**
 * The file an agent's workspace connection is written to, as a name.
 *
 * Folded to a safe set, case-folded because two of the three platforms' file
 * systems are, and prefixed so a name like `con` cannot become a Windows device.
 */
export function mcpFileNameFor(agentName: string): string {
  return `agent-${agentName.toLowerCase().replace(/[^a-z0-9._-]+/g, "_")}.json`;
}

/** The variable name offered for an agent's connection key. */
export function connectionKeyVariableFor(agentName: string): string {
  const folded = agentName.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `MDBRAIN_KEY_${folded || "AGENT"}`;
}

/** What the per-agent questions are offered with: the existing answers, or the defaults. */
export interface AgentDefaults {
  cwd: string;
  /** Null is the harness's own signed-in account; a string is the variable holding a key. */
  harnessVariable: string | null;
  /**
   * The variable the connection key reaches the harness through. Derived rather
   * than asked: the key itself is minted by the server and kept in this
   * machine's key store, so there is nothing here for a person to decide.
   */
  connectionKeyVariable: string;
  bounds: Bounds;
  /**
   * Whether `run` asks for this agent's work — the second selection's answer,
   * carried here because it decides which of the remaining questions exist.
   *
   * Not asked per agent: it is one list answered once, and asking it again here
   * would be two places a person could say two different things.
   */
  pollsWork: boolean;
}

/**
 * What one agent's questions are offered with.
 *
 * Three sources, most recent first: **a draft** left by a `configure` that was
 * quit part-way, then **the existing config**, then the defaults. The draft
 * comes first because it is the answer most recently given by hand, and the
 * whole point of keeping it is that quitting costs keystrokes rather than work.
 */
export function agentDefaults(
  agentName: string,
  existing: AgentEntry | null,
  currentDirectory: string,
  draft: DraftAgent | null = null,
): AgentDefaults {
  // `null` is a real answer here and `undefined` is *not answered yet*, so the
  // draft's value is taken on presence rather than on truthiness.
  const harnessFromExisting = existing ? existing.env.harness : HARNESS_CREDENTIAL_VARIABLE;
  return {
    cwd: draft?.cwd ?? existing?.cwd ?? currentDirectory,
    harnessVariable: draft?.harnessVariable !== undefined ? draft.harnessVariable : harnessFromExisting,
    connectionKeyVariable: existing?.env.connectionKey ?? connectionKeyVariableFor(agentName),
    bounds: draft?.bounds ?? existing?.bounds ?? DEFAULT_BOUNDS,
    // A starting value only. The answer is the second selection's, and the
    // caller overwrites this with it before the first question is asked.
    pollsWork: existing?.pollsWork ?? true,
  };
}

/**
 * One agent's answers so far, as a `configure` that was quit part-way left them.
 *
 * Every field is optional because a draft is a snapshot of an unfinished
 * sequence, and `undefined` has to mean *not answered yet* rather than *answered
 * as nothing* — `harnessVariable` is the field that makes that distinction load
 * bearing, since `null` there is a real answer.
 */
export interface DraftAgent {
  id: string;
  cwd?: string;
  harnessVariable?: string | null;
  bounds?: Bounds;
}

/**
 * A `configure` in progress, written after every answer.
 *
 * It exists because nothing used to be written until the last question, so
 * quitting in the middle threw away every answer given. This is deliberately
 * **not** resume-where-you-left-off: the next run walks the whole sequence
 * again and offers these as the values, so every earlier answer stays reviewable
 * and changeable on the way past, and there is one code path rather than two.
 *
 * It holds no secret — paths, a variable name, numbers — which is what lets it
 * sit beside `config.json` rather than under the state root.
 */
export interface ConfigureDraft {
  version: number;
  /** The agents marked, by id, in the order they are asked about. */
  chosen: string[];
  /**
   * The agents marked as pollers, by id — **absent until the question has been
   * answered**, since an empty list is a real answer to it.
   */
  pollers?: string[];
  agents: Record<string, DraftAgent>;
  /** The ids of renamed entries the person chose NOT to keep — an answer like any other. */
  dropped: string[];
  sessionsPerHour?: number | null;
}

/** The shape this build writes drafts in. A draft of any other version is discarded. */
export const DRAFT_VERSION = 1;

/**
 * Read a draft, or answer null.
 *
 * Tolerant where {@link parseConfig} is strict, and for the opposite reason: a
 * config is a contract a person may have written by hand, so a bad one is
 * refused by name; a draft is this program's own convenience, so a bad one is
 * simply not offered. Refusing to configure because a scratch file is corrupt
 * would be the store deciding it matters more than the thing it assists.
 */
export function parseDraft(text: string): ConfigureDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== DRAFT_VERSION) return null;
  const chosen = Array.isArray(raw.chosen) ? raw.chosen.filter((v): v is string => typeof v === "string") : [];
  const agents: Record<string, DraftAgent> = {};
  if (typeof raw.agents === "object" && raw.agents !== null && !Array.isArray(raw.agents)) {
    for (const [id, entry] of Object.entries(raw.agents as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const agent: DraftAgent = { id };
      if (typeof e.cwd === "string") agent.cwd = e.cwd;
      if (typeof e.harnessVariable === "string" || e.harnessVariable === null) agent.harnessVariable = e.harnessVariable;
      const bounds = readDraftBounds(e.bounds);
      if (bounds) agent.bounds = bounds;
      agents[id] = agent;
    }
  }
  const dropped = Array.isArray(raw.dropped) ? raw.dropped.filter((v): v is string => typeof v === "string") : [];
  const read: ConfigureDraft = { version: DRAFT_VERSION, chosen, agents, dropped };
  // Only when the key is there, so *never answered* survives the round trip: a
  // missing key read as an empty list would offer a later run a configuration in
  // which nobody polls, which is the opposite of what a draft is for.
  if (Array.isArray(raw.pollers)) read.pollers = raw.pollers.filter((v): v is string => typeof v === "string");
  if (typeof raw.sessionsPerHour === "number" || raw.sessionsPerHour === null) read.sessionsPerHour = raw.sessionsPerHour;
  return read;
}

function readDraftBounds(v: unknown): Bounds | null {
  if (typeof v !== "object" || v === null) return null;
  const b = v as Record<string, unknown>;
  if (typeof b.maxTurns !== "number" || typeof b.maxBudgetUsd !== "number" || typeof b.wallClock !== "string") return null;
  return { maxTurns: b.maxTurns, maxBudgetUsd: b.maxBudgetUsd, wallClock: b.wallClock };
}

/**
 * The completions for a directory being typed, in the form it was typed in.
 *
 * Tab completion is what every shell has trained everyone to expect, and typing
 * a long checkout path by hand is the alternative. The rule is the shell's: what
 * is before the last separator names the directory to list, what is after it is
 * the prefix to match, and a completed directory comes back with a trailing
 * separator so the next Tab walks into it.
 *
 * Pure: the listing is handed in, so this is testable without a filesystem and
 * cannot be surprised by one.
 *
 * @param listDirectory the sub-directory names of an absolute path, or [] when it is not a directory
 * @returns every match, in the typed form, ordered — empty when there is nothing to offer
 */
export function completePath(input: string, currentDirectory: string, listDirectory: (path: string) => string[]): string[] {
  const typed = input.trim();
  // A separator at the end means the directory itself is complete and its
  // children are the candidates, so the prefix is empty rather than its name.
  const endsAtSeparator = typed.endsWith("/") || typed.endsWith("\\");
  const typedDirectory = endsAtSeparator ? typed : dirname(typed);
  const prefix = endsAtSeparator ? "" : basename(typed);
  // `dirname` of a bare name is ".", which is the current directory rather than
  // a directory the person named — keep the typed form empty so the completion
  // does not acquire a "./" the person did not write.
  const shownDirectory = typed === "" || (!endsAtSeparator && typedDirectory === ".") ? "" : typedDirectory;
  const resolved = resolvePath(currentDirectory, shownDirectory === "" ? "." : shownDirectory);
  // The separator is read off what was typed rather than chosen for the
  // platform: Windows accepts both, and a completion that swaps the one the
  // person is using rewrites their line under them.
  const separator = separatorOf(typed);
  const fold = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;
  return listDirectory(resolved)
    .filter((name) => fold(name).startsWith(fold(prefix)))
    .sort(compareNames)
    .map((name) => (shownDirectory === "" ? name : joinTyped(shownDirectory, name, separator)) + separator);
}

/** The separator the person is using, or the platform's when they have not used one yet. */
function separatorOf(typed: string): string {
  const backslash = typed.lastIndexOf("\\");
  const slash = typed.lastIndexOf("/");
  if (backslash === -1 && slash === -1) return sep;
  return backslash > slash ? "\\" : "/";
}

/** Join a completion back onto the directory the person typed, keeping their separator. */
function joinTyped(typedDirectory: string, name: string, separator: string): string {
  return typedDirectory.endsWith("/") || typedDirectory.endsWith("\\")
    ? `${typedDirectory}${name}`
    : `${typedDirectory}${separator}${name}`;
}

/** An answer judged: accepted (with a warning to show, if any) or refused with the reason. */
export type Judgement<T> = { ok: true; value: T; warning?: string } | { ok: false; problem: string };

/**
 * The working directory, checked to exist now: a typo here is a session that
 * starts nowhere. A relative answer is taken relative to where `configure` was
 * started, which is the one directory the person can see.
 *
 * @param isDirectory answers whether an absolute path is a directory that exists
 */
export function judgeCwd(input: string, currentDirectory: string, isDirectory: (path: string) => boolean): Judgement<string> {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, problem: "A directory is needed." };
  const path = isAbsolute(trimmed) ? trimmed : resolvePath(currentDirectory, trimmed);
  if (!isDirectory(path)) return { ok: false, problem: `${path} is not a directory that exists.` };
  return { ok: true, value: path };
}

/**
 * A credential variable's name — refused when it is not a name or is a value,
 * warned about when it is not set here.
 */
export function judgeVariable(input: string, env: Record<string, string | undefined>, what: string): Judgement<string> {
  const name = input.trim();
  if (looksLikeSecret(name)) {
    return { ok: false, problem: `That looks like the ${what} itself. Put it in an environment variable and give that variable's name here.` };
  }
  if (!isVariableName(name)) return { ok: false, problem: `${JSON.stringify(name)} is not an environment variable name.` };
  if (env[name] === undefined || env[name] === "") {
    return { ok: true, value: name, warning: `${name} is not set in this shell. Set it in the shell you start mdbrain run from.` };
  }
  return { ok: true, value: name };
}

export function judgeTurns(input: string): Judgement<number> {
  const n = Number(input.trim());
  return Number.isInteger(n) && n >= 1 ? { ok: true, value: n } : { ok: false, problem: "A whole number of turns, at least 1." };
}

export function judgeBudget(input: string): Judgement<number> {
  const n = Number(input.trim());
  return Number.isFinite(n) && n > 0 ? { ok: true, value: n } : { ok: false, problem: "A positive number of dollars, such as 5." };
}

export function judgeDuration(input: string, minimumMs = 1): Judgement<string> {
  const text = input.trim();
  const ms = durationMs(text);
  if (ms === null) return { ok: false, problem: "A duration with a unit, such as 30m or 90s — and no longer than 24 days." };
  if (ms < minimumMs) return { ok: false, problem: `At least ${Math.round(minimumMs / 1000)}s.` };
  return { ok: true, value: text };
}

/** The runner's ceiling: blank keeps the server's, a number is held to the server's cap. */
export function judgeCeiling(input: string): Judgement<number | null> {
  const text = input.trim();
  if (text === "") return { ok: true, value: null };
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) return { ok: false, problem: "A whole number of sessions an hour, or blank for the server's ceiling." };
  if (n > SESSION_CAP_HARD_MAX) {
    return { ok: false, problem: `The server's ceiling is ${SESSION_CAP_HARD_MAX} an hour and cannot be raised from here; ${n} would be ignored.` };
  }
  return { ok: true, value: n };
}

/** What the screen hands back when every question has been answered. */
export interface Answers {
  agents: Array<{ name: string; id: string } & AgentDefaults>;
  sessionsPerHour: number | null;
  /** Renamed entries the person chose not to keep under the new name — dropped, and said so. */
  dropped: RenamedEntry[];
}

/** The answers as the file: the only way a config is made from a screen. */
export function assembleConfig(answers: Answers): Config {
  const agents = newAgentMap();
  for (const a of answers.agents) {
    agents[a.name] = {
      id: a.id,
      harness: "claude",
      pollsWork: a.pollsWork,
      cwd: a.cwd,
      env: { harness: a.harnessVariable, connectionKey: a.connectionKeyVariable },
      bounds: a.bounds,
    };
  }
  return { version: CONFIG_VERSION, sessionsPerHour: answers.sessionsPerHour, agents };
}

/** What the write reports: where the config went, the MCP file each agent got, and the stale files removed. */
export interface WriteReport {
  path: string;
  mcpPaths: Record<string, string>;
  removed: string[];
}

/** What became of one agent's connection key, by agent name. */
export type KeyOutcome =
  | { kind: "minted" }
  | { kind: "renewed" }
  | { kind: "held" }
  | { kind: "failed"; problem: string };

/** The lines printed once the file is written. */
export function summaryLines(
  config: Config,
  report: WriteReport,
  disappeared: DisappearedEntry[],
  dropped: RenamedEntry[],
  keys: Record<string, KeyOutcome> = {},
): string[] {
  const lines = [`Configuration written to ${report.path}.`, ""];
  for (const [name, entry] of Object.entries(config.agents)) {
    lines.push(`  ${name}`);
    lines.push(`    runs in ${entry.cwd}`);
    lines.push(
      entry.env.harness === null
        ? "    thinks with this machine's own Claude Code account"
        : `    thinks with the key in ${entry.env.harness}`,
    );
    lines.push(`    ${connectionKeyLine(keys[name], entry.env.connectionKey)}`);
    if (report.mcpPaths[name]) lines.push(`    workspace connection ${report.mcpPaths[name]}`);
    // Said for both answers rather than only for the unusual one. The two
    // entries are identical in the file but for one field, so a summary that
    // marked only the identity-only ones would leave a reader checking the
    // absence of a line to learn what the other agents do.
    //
    // **In `run`'s vocabulary — *asked for work* — rather than in the screen's
    // *polls*.** This block is the one surface that must not acquire a sentence
    // about polling: the interval stopped being a setting and the line saying so
    // was taken out of here, and a summary that says *polls* again is how it
    // comes back by a side door.
    lines.push(
      entry.pollsWork
        ? "    asked for work by mdbrain run"
        : "    identity only: mdbrain as starts a session as it, and mdbrain run never asks for its work",
    );
  }
  for (const gone of disappeared) {
    if (config.agents[gone.name]) lines.push(`  ${gone.name} is ${gone.reason}, and will receive no work until that changes.`);
  }
  for (const d of dropped) {
    // Only when it really is absent. Declining the rename unmarks the entry, and
    // the agent is still on the list under its new name, so a person who then
    // marks it has one — and being told it was dropped would contradict the file
    // this same summary just described.
    if (!config.agents[d.to]) {
      lines.push(`  ${d.from} was dropped: the roster now calls it ${d.to}, and you chose not to keep it under that name.`);
    }
  }
  for (const path of report.removed) lines.push(`  removed ${path}, which belonged to an agent no longer configured here`);
  lines.push("");
  lines.push(
    config.sessionsPerHour === null
      ? `Ceiling: the server's, ${SESSION_CAP_HARD_MAX} sessions an hour per agent.`
      : `Ceiling: ${config.sessionsPerHour} sessions an hour per agent.`,
  );
  // A legal configuration, and one nobody should discover from `run` refusing to
  // start. It is said here because this is the screen where it was decided, and
  // `run`'s own refusal names the same fact from the other end.
  if (Object.values(config.agents).every((entry) => !entry.pollsWork)) {
    lines.push("");
    lines.push("No agent here is asked for work, so mdbrain run has nobody to ask. This machine is configured for mdbrain as.");
  }
  return lines;
}

/**
 * What to say about one agent's connection key.
 *
 * A failure is said in place rather than aborting the write: the configuration
 * is still correct, and the agent it belongs to is the only one affected.
 *
 * **The remedy it names is `configure` itself**, because that is the one that works:
 * `run` takes the key from this machine's key store and refuses the agent's work
 * when the store has none, so a key pasted into the variable by hand would never
 * be reached.
 */
function connectionKeyLine(outcome: KeyOutcome | undefined, variable: string): string {
  switch (outcome?.kind) {
    case "minted":
      return "connection key requested from markdown-den and stored on this machine";
    case "renewed":
      return "a fresh connection key requested from markdown-den and stored on this machine, replacing the one that was here (the old one stays live until it is revoked in the app)";
    case "held":
      return "connection key already stored on this machine, and kept (mdbrain configure --new-keys mints another)";
    case "failed": {
      // Punctuated here rather than at each throw site, so that a message which
      // ends in a full stop and one which does not read the same in the summary.
      const problem = outcome.problem.endsWith(".") ? outcome.problem : `${outcome.problem}.`;
      return `no connection key: ${problem} mdbrain run will refuse this agent's work until mdbrain configure stores one.`;
    }
    default:
      return `connection key expected in ${variable}`;
  }
}
