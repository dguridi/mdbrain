// What the runner's own configuration file is, and what it refuses.
//
// The file holds local execution only: which agents this machine runs and how
// each one is invoked. Nothing about what to watch — that is compiled server-side
// out of the brain's own configuration, which this program never opens — and
// **never a secret**: this is the file a person copies to a second machine, so a
// credential field holds the NAME of an environment variable, never a value.
// The one credential this program does hold — the agent's connection key, which
// `configure` asks the server for — lives in the machine's key store under the
// state root, never here; `secrets.ts` is where that boundary is kept.
//
// Pure, in the shape the session decision has: text in, a config or one sentence
// out, no disk anywhere. That is what lets every refusal be tested without a
// file, and what lets a hand-written or copied file be a first-class input rather
// than a fallback — `parseConfig` is the whole contract, and `configure` is one
// writer of it.
//
// **Versioned from the first write.** The file lives on other people's machines
// and cannot be migrated by deploying, so the version is the first thing read and
// the one field that decides whether the shape as a whole is understood. Below
// it, fields this build does not know are tolerated, so a file written by a later
// minor addition still reads.

import { isAbsolute } from "node:path";

/** The shape this build writes and reads. */
export const CONFIG_VERSION = 1;

/**
 * The server's hard cap on sessions an hour per agent. Duplicated here rather
 * than imported, because this program imports nothing from the rest of the
 * repository; the server clamps to its own copy, so a disagreement between the
 * two shows up as a refusal at write time rather than a silent clamp on the wire.
 */
export const SESSION_CAP_HARD_MAX = 10;

/** The harnesses this build can start. A name outside this list is refused by name. */
export const KNOWN_HARNESSES = ["claude"] as const;
export type HarnessId = (typeof KNOWN_HARNESSES)[number];

/** The bounds one session runs under: two the harness enforces, one the runner does. */
export interface Bounds {
  maxTurns: number;
  maxBudgetUsd: number;
  /** A duration with a unit, `30m`; the runner's outer bound. */
  wallClock: string;
}

/** One agent this machine runs. Keyed in the file by the agent's display name. */
export interface AgentEntry {
  /** The agent's row id at configure time — what tells *renamed* from *gone*. */
  id: string;
  harness: HarnessId;
  /** The directory the harness is started in. Absolute. */
  cwd: string;
  env: {
    /**
     * The variable holding the harness's own credential, or **null** for the
     * harness's own signed-in account.
     *
     * Null is a first-class answer rather than an omission. A person who runs
     * `claude` in their shell with no key at all has a credential the harness
     * already holds, and naming a variable they do not have would make a
     * mandatory step out of something they do not need. It also decides a
     * question the variable cannot: with null recorded, `run` **removes** the
     * harness's own variable from the child's environment, so a key left in the
     * shell cannot quietly stand in for the account that was chosen.
     */
    harness: string | null;
    /**
     * The variable the agent's markdown-den connection key reaches the harness
     * through. The name only: the value is minted by the server and kept in
     * this machine's key store, and `run` sets the variable in the child's
     * environment from there.
     */
    connectionKey: string;
  };
  bounds: Bounds;
}

/** The whole file, as this build understands it. */
export interface Config {
  version: typeof CONFIG_VERSION;
  /** How often `run` asks, with a unit. */
  poll: string;
  /** The runner's ceiling on sessions an hour per agent, or null to let the server's stand. */
  sessionsPerHour: number | null;
  agents: Record<string, AgentEntry>;
}

/** What a read of the text produced: a config, or the sentence refusing it. */
export type ConfigReading = { kind: "config"; config: Config } | { kind: "problem"; message: string };

export const DEFAULT_POLL = "5m";
export const DEFAULT_BOUNDS: Bounds = { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" };
/** The least often `run` may be asked to poll. */
export const MIN_POLL_MS = 30_000;
/** The longest duration a timer can hold: past this, `setTimeout` fires at once rather than never. */
export const MAX_DURATION_MS = 2_147_483_647;

/**
 * An empty agents map with no prototype, so an agent named `__proto__` is an
 * entry like any other rather than an assignment to the object's prototype —
 * which would pass every check on the map and leave it empty.
 */
export function newAgentMap(): Record<string, AgentEntry> {
  return Object.create(null) as Record<string, AgentEntry>;
}

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * A duration written with a unit, as milliseconds — or null when it is not one.
 *
 * A bare number is refused on purpose: it is the one value two readers can
 * disagree about while both look right.
 */
export function durationMs(text: string): number | null {
  const match = /^(\d+)([smh])$/.exec(text.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const ms = amount * UNITS[match[2]];
  return amount > 0 && ms <= MAX_DURATION_MS ? ms : null;
}

/** Whether text is a legal environment variable name. */
export function isVariableName(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}

/**
 * Whether a value is a secret rather than the name of one.
 *
 * The two prefixes are the two credentials a person is most likely to paste here
 * by mistake: an Anthropic key and a markdown-den connection key. Refusing them
 * by shape is what keeps the promise that nothing in this file is worth stealing.
 */
export function looksLikeSecret(text: string): boolean {
  return /^(sk-|smd_agent_)/.test(text.trim());
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One sentence refusing a field, naming it. */
function problem(message: string): ConfigReading {
  return { kind: "problem", message };
}

function readBounds(v: unknown, at: string): Bounds | string {
  const raw = v === undefined ? {} : v;
  if (!isRecord(raw)) return `${at}.bounds must be an object.`;
  const maxTurns = raw.maxTurns === undefined ? DEFAULT_BOUNDS.maxTurns : raw.maxTurns;
  const maxBudgetUsd = raw.maxBudgetUsd === undefined ? DEFAULT_BOUNDS.maxBudgetUsd : raw.maxBudgetUsd;
  const wallClock = raw.wallClock === undefined ? DEFAULT_BOUNDS.wallClock : raw.wallClock;
  if (!Number.isInteger(maxTurns) || (maxTurns as number) < 1) return `${at}.bounds.maxTurns must be a whole number of turns.`;
  if (typeof maxBudgetUsd !== "number" || !(maxBudgetUsd > 0)) return `${at}.bounds.maxBudgetUsd must be a positive number of dollars.`;
  if (typeof wallClock !== "string" || durationMs(wallClock) === null) {
    return `${at}.bounds.wallClock must be a duration with a unit, such as 30m.`;
  }
  return { maxTurns: maxTurns as number, maxBudgetUsd, wallClock };
}

function readVariable(v: unknown, at: string): string | { message: string } {
  if (typeof v !== "string" || v === "") return { message: `${at} must name an environment variable.` };
  if (looksLikeSecret(v)) {
    return { message: `${at} holds what looks like a key. Put the key in an environment variable and write that variable's name here.` };
  }
  if (!isVariableName(v)) return { message: `${at} must be a legal environment variable name, not "${v}".` };
  return v;
}

function readAgent(name: string, v: unknown): AgentEntry | string {
  const at = `agents["${name}"]`;
  if (!isRecord(v)) return `${at} must be an object.`;
  if (typeof v.id !== "string" || v.id === "") return `${at}.id must be the agent's id.`;
  if (typeof v.harness !== "string" || !(KNOWN_HARNESSES as readonly string[]).includes(v.harness)) {
    return `${at}.harness names a harness this build does not have: ${JSON.stringify(v.harness)}. Known: ${KNOWN_HARNESSES.join(", ")}.`;
  }
  if (typeof v.cwd !== "string" || !isAbsolute(v.cwd)) return `${at}.cwd must be an absolute path.`;
  if (!isRecord(v.env)) return `${at}.env must say where the credentials come from.`;
  // Absent or null is the harness's own signed-in account, and is written as an
  // absent field: a file that never mentions a variable is the honest record of
  // an agent that needs none.
  let harness: string | null = null;
  if (v.env.harness !== undefined && v.env.harness !== null) {
    const read = readVariable(v.env.harness, `${at}.env.harness`);
    if (typeof read !== "string") return read.message;
    harness = read;
  }
  const connectionKey = readVariable(v.env.connectionKey, `${at}.env.connectionKey`);
  if (typeof connectionKey !== "string") return connectionKey.message;
  const bounds = readBounds(v.bounds, at);
  if (typeof bounds === "string") return bounds;
  if ("command" in v) return `${at}.command is not a field: the harness's command line is this program's, not the file's.`;
  return { id: v.id, harness: v.harness as HarnessId, cwd: v.cwd, env: { harness, connectionKey }, bounds };
}

/**
 * Reads the file's text into a config, or refuses it in one sentence.
 *
 * The version is read first and decides everything: absent or unknown is
 * refused by name, and a version newer than this build is refused with a
 * sentence naming an upgrade, since the remedy is not an edit.
 */
export function parseConfig(text: string): ConfigReading {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return problem("config.json is not JSON.");
  }
  if (!isRecord(value)) return problem("config.json must be a JSON object.");
  if (value.version === undefined) return problem("config.json has no version. This build writes version 1.");
  if (typeof value.version !== "number" || !Number.isInteger(value.version)) {
    return problem(`config.json's version must be a whole number, not ${JSON.stringify(value.version)}.`);
  }
  if (value.version > CONFIG_VERSION) {
    return problem(`config.json is version ${value.version}, and this build of mdbrain reads up to version ${CONFIG_VERSION}. Upgrade mdbrain rather than editing the file.`);
  }
  if (value.version < CONFIG_VERSION) {
    return problem(`config.json is version ${value.version}, which this build does not know.`);
  }

  const poll = value.poll === undefined ? DEFAULT_POLL : value.poll;
  if (typeof poll !== "string" || durationMs(poll) === null) return problem("poll must be a duration with a unit, such as 5m.");
  if (durationMs(poll)! < MIN_POLL_MS) return problem("poll must be at least 30s.");

  let sessionsPerHour: number | null = null;
  if (value.sessionsPerHour !== undefined && value.sessionsPerHour !== null) {
    const cap = value.sessionsPerHour;
    if (!Number.isInteger(cap) || (cap as number) < 1) return problem("sessionsPerHour must be a whole number of sessions.");
    if ((cap as number) > SESSION_CAP_HARD_MAX) {
      return problem(`sessionsPerHour is ${cap}, above the server's ceiling of ${SESSION_CAP_HARD_MAX}; the server would ignore it, so it is refused here instead.`);
    }
    sessionsPerHour = cap as number;
  }

  if (!isRecord(value.agents) || Object.keys(value.agents).length === 0) {
    return problem("agents must name at least one agent this machine runs.");
  }
  const agents = newAgentMap();
  for (const [name, entry] of Object.entries(value.agents)) {
    if (name.trim() === "") return problem("An agent's name cannot be empty.");
    const read = readAgent(name, entry);
    if (typeof read === "string") return problem(read);
    agents[name] = read;
  }
  return { kind: "config", config: { version: CONFIG_VERSION, poll, sessionsPerHour, agents } };
}

/**
 * The text the file is written as: only the fields this build knows, in a
 * stable order, so two writes of the same config are byte-identical and a diff
 * of the file reads as a change of intent.
 */
export function serializeConfig(config: Config): string {
  // Built on the same prototype-less map the reader uses, and for the same
  // reason: `agents["__proto__"] = entry` on an ordinary object sets that
  // object's prototype instead of adding a key, so the entry would vanish here
  // rather than at the parse the map was written to survive.
  const agents = newAgentMap() as unknown as Record<string, unknown>;
  for (const [name, entry] of Object.entries(config.agents)) {
    const env: Record<string, string> = {};
    // Written only when there is one: an absent field says "the harness's own
    // account" without a reader having to know that null means that too.
    if (entry.env.harness !== null) env.harness = entry.env.harness;
    env.connectionKey = entry.env.connectionKey;
    agents[name] = {
      id: entry.id,
      harness: entry.harness,
      cwd: entry.cwd,
      env,
      bounds: { maxTurns: entry.bounds.maxTurns, maxBudgetUsd: entry.bounds.maxBudgetUsd, wallClock: entry.bounds.wallClock },
    };
  }
  const out: Record<string, unknown> = { version: config.version, poll: config.poll };
  if (config.sessionsPerHour !== null) out.sessionsPerHour = config.sessionsPerHour;
  out.agents = agents;
  return `${JSON.stringify(out, null, 2)}\n`;
}
