// `mdbrain agents` — what this machine holds, whether each agent's key works
// here, and the two things a person may do about it: renew a key, or remove an
// agent's configuration.
//
// No other command says what is configured, where, or under which key, so this
// is where a machine whose agents cannot connect gets diagnosed. Bare, it is the
// report — a plain one with no terminal, a browser with one. `check` is the
// verdict on each key; `remove` and `renew` are the only writers.
//
// **A consumer until a writer is asked for.** The report and `check` write
// nothing on this machine: no config, no connection file, no key store. The one
// thing they leave behind is on the server, which stamps a key it accepts as
// used. `remove` and `renew` are the writers, and both are guarded the same
// way: each takes the agent's **whole name**, never a prefix, each says what it
// is about to do and waits for `y` at a terminal, and with no terminal each
// refuses without `--yes` — a script that deletes or revokes on a typo is worse
// than one that stops.
//
// **The check presents the key itself.** The MCP server is the only thing that
// can say whether a key works, so the key is sent to it as a harness would send
// it. Only when it is refused does the command read, as the person, what they
// already have a right to see — the roster, their roles, the agent's key list —
// to say why. Signed out, the refusal stands on its own and says to sign in.
//
// Everything a test would want to vary is a dependency; the command is the order.

import type { CommandContext, CommandSpec } from "../cli.ts";
import {
  currentUser,
  listAgentKeys,
  listAgents,
  listMemberships,
  mintAgentKey,
  presentConnectionKey,
  revokeAgentKey,
  type KeyAnswer,
  type KeyRow,
} from "../auth/api.ts";
import { configPath, stateDir } from "../config/paths.ts";
import type { AgentEntry, Config } from "../config/schema.ts";
import {
  keyPrefixOf,
  keyStorageLine,
  openConnectionKeyStore,
  shownKey,
  type ConnectionKeyStore,
} from "../config/secrets.ts";
import { loadConfig, mcpConfigPath, mcpDir, removeConfig, removeMcpConfig, saveConfig } from "../config/store.ts";
import { ambiguousAgentMessage, resolveAgent } from "../as/choose.ts";
import { agentLines, locationLines, reportLines, type Locations } from "../agents/report.ts";
import { retireKey, retirementSentence, type RetireCalls } from "../agents/retire.ts";
import { browseOnScreen, confirmOnScreen, type BrowserPlan, type BrowserRow } from "../agents/screen.ts";
import {
  isAccepted,
  needsKeys,
  readProbe,
  unreachedProbe,
  verdictFor,
  verdictSentence,
  type CheckedEntry,
  type OwnerView,
  type Verdict,
} from "../agents/verdict.ts";
import { diagnosisPath, redactSecrets } from "../run/diagnosis.ts";
import { runLogPath } from "../run/log.ts";
import { noConfigMessage, UNREADABLE_CONFIG_MESSAGE } from "./run.ts";
import { readySession, type SessionOutcome } from "./session.ts";
import { configureAt } from "./configure.ts";

/**
 * How long `agents check` waits for the MCP server before calling a key
 * unchecked. Long enough for a cold start, short enough that a dead network
 * does not hold a person at the prompt.
 */
export const CHECK_TIMEOUT_MS = 10_000;

/** What the command needs from outside itself, so a test can stand each one in. */
export interface AgentsDeps {
  /** Whether a person is at the terminal: both streams, as `configure` and `as` ask it. */
  isTTY: boolean;
  env: Record<string, string | undefined>;
  loadConfiguration: typeof loadConfig;
  openKeyStore: () => Promise<ConnectionKeyStore>;
  session: () => Promise<SessionOutcome>;
  /** Presents a key to the MCP server. Throws when no answer came back. */
  present: (key: string, signal: AbortSignal) => Promise<KeyAnswer>;
  /** What the person's own session can see: every visible agent, and the organizations they own. */
  ownerView: (accessToken: string) => Promise<OwnerView>;
  listKeys: RetireCalls["listKeys"];
  revoke: RetireCalls["revoke"];
  mint: (accessToken: string, agentId: string) => Promise<string>;
  saveConfiguration: (config: Config) => Promise<string>;
  removeConfiguration: () => Promise<void>;
  removeMcpFile: (agentName: string) => Promise<string>;
  /** Draws the browser and resolves when the person leaves it. */
  browse: (plan: BrowserPlan) => Promise<void>;
  /** Shows what is about to happen and answers whether the person said yes. */
  confirm: (lines: string[]) => Promise<boolean>;
  /**
   * Opens configure's menu at one agent's rows, answering configure's exit code.
   * What `e` hands over to: this command edits no setting itself.
   */
  configure: (openAt: string, context: CommandContext) => Promise<number>;
}

/** The roster read the refusal table rests on, made as the person. */
async function readOwnerView(accessToken: string): Promise<OwnerView> {
  const me = await currentUser(accessToken);
  if (!me.id) throw new Error("the server did not say which account this session belongs to");
  const [agents, memberships] = await Promise.all([listAgents(accessToken), listMemberships(accessToken, me.id)]);
  return { agents, ownedOrgIds: new Set(memberships.filter((m) => m.role === "owner").map((m) => m.org_id)) };
}

const defaultDeps = (): AgentsDeps => ({
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  env: process.env,
  loadConfiguration: loadConfig,
  openKeyStore: () => openConnectionKeyStore(),
  session: readySession,
  present: presentConnectionKey,
  ownerView: readOwnerView,
  listKeys: listAgentKeys,
  revoke: revokeAgentKey,
  mint: mintAgentKey,
  saveConfiguration: (config) => saveConfig(config),
  removeConfiguration: () => removeConfig(),
  removeMcpFile: (name) => removeMcpConfig(name),
  browse: browseOnScreen,
  confirm: confirmOnScreen,
  configure: configureAt,
});

/** The usage line, for a subcommand that is not one of the three or a name that is missing. */
export const AGENTS_USAGE = "Usage: mdbrain agents [check [agent] | remove <agent> | renew <agent>].";

/** The refusal for a writer with no terminal to ask at and no `--yes`. */
export function needsYesMessage(sub: "remove" | "renew"): string {
  return `mdbrain agents ${sub} needs a terminal to confirm at. To ${sub} without asking, add --yes.`;
}

/** The sentence for a name that is not configured here. */
function notConfiguredMessage(name: string, configured: string[]): string {
  const known = configured.length === 0 ? "nothing is configured here" : `configured here: ${configured.join(", ")}`;
  return `${name} is not configured on this machine — ${known}.`;
}

/** Where things are, for the report's first lines. */
function locations(store: ConnectionKeyStore, env: Record<string, string | undefined>): Locations {
  return {
    configPath: configPath(),
    stateDir: stateDir(),
    mcpDir: mcpDir(),
    diagnosisPath: diagnosisPath(),
    runLogPath: runLogPath(),
    keyStorage: keyStorageLine(store.backend),
    configMoved: Boolean(env.MDBRAIN_CONFIG_DIR),
    stateMoved: Boolean(env.MDBRAIN_STATE_DIR),
  };
}

/**
 * What the store holds for one agent.
 *
 * **A read that fails is its own answer, never *no key*.** Read as none, a locked
 * keychain would send `check` to say *renew*, and `renew` and `remove` would
 * each skip the revoke of a key that is still there — leaving exactly the live
 * key nobody holds that revoking is for.
 */
type Held = { kind: "key"; key: string; prefix: string | null } | { kind: "none" } | { kind: "unreadable"; problem: string };

async function readHeld(store: ConnectionKeyStore, id: string): Promise<Held> {
  try {
    const key = await store.get(id);
    return key === null ? { kind: "none" } : { kind: "key", key, prefix: keyPrefixOf(key) };
  } catch (cause) {
    return { kind: "unreadable", problem: (cause as Error).message };
  }
}

/** The prefix of the key this machine holds for each configured id: null for none, or *unreadable*. */
async function heldPrefixes(config: Config, store: ConnectionKeyStore): Promise<Record<string, string | null | "unreadable">> {
  const held: Record<string, string | null | "unreadable"> = {};
  for (const entry of Object.values(config.agents)) {
    const read = await readHeld(store, entry.id);
    held[entry.id] = read.kind === "key" ? read.prefix : read.kind === "none" ? null : "unreadable";
  }
  return held;
}

/**
 * The person's session, asked for by one caller at a time.
 *
 * A refresh spends the refresh token it is given, so two refreshes started
 * together race for one token and the loser reads as a session the server has
 * ended. The browser can start a check's read and a renew's in the same moment,
 * so both go through here and share whichever refresh is already under way.
 */
function oneSessionAtATime(session: () => Promise<SessionOutcome>): () => Promise<SessionOutcome> {
  let pending: Promise<SessionOutcome> | null = null;
  return () => {
    pending ??= session().finally(() => {
      pending = null;
    });
    return pending;
  };
}

/**
 * The verdict on one agent, given the person's session at most once per run.
 *
 * The owner view is read lazily and shared: most checks are accepted and need
 * no read at all, and a run over many refused agents reads the roster once.
 */
function checker(deps: AgentsDeps, store: ConnectionKeyStore) {
  let owner: Promise<{ token: string; view: OwnerView } | { token: null } | { failed: string }> | null = null;
  const ownerOnce = () =>
    (owner ??= deps.session().then(async (session) => {
      if (session.kind === "stop") return { token: null };
      try {
        return { token: session.accessToken, view: await deps.ownerView(session.accessToken) };
      } catch (cause) {
        return { failed: redactSecrets((cause as Error).message) };
      }
    }));

  return async (name: string, config: Config): Promise<{ verdict: Verdict; prefix: string | null }> => {
    const entry = config.agents[name];
    const checked: CheckedEntry = { name, id: entry.id, configuredIds: new Set(Object.values(config.agents).map((e) => e.id)) };
    const held = await readHeld(store, entry.id);
    if (held.kind === "unreadable") {
      return { verdict: { kind: "unchecked", reason: `the key store could not be read (${held.problem})` }, prefix: null };
    }
    if (held.kind === "none") return { verdict: verdictFor({ kind: "no-key" }, checked, null, null, null), prefix: null };
    const { key, prefix } = held;
    const probe = await deps.present(key, AbortSignal.timeout(CHECK_TIMEOUT_MS)).then(readProbe, unreachedProbe);
    if (probe.kind !== "refused") return { verdict: verdictFor(probe, checked, prefix, null, null), prefix };
    const seen = await ownerOnce();
    if ("failed" in seen) {
      return { verdict: { kind: "refused", cause: { kind: "unexplained" } }, prefix };
    }
    if (seen.token === null) return { verdict: verdictFor(probe, checked, prefix, null, null), prefix };
    const keys: KeyRow[] | null = needsKeys(checked, seen.view)
      ? await deps.listKeys(seen.token, entry.id).catch(() => null)
      : null;
    return { verdict: verdictFor(probe, checked, prefix, seen.view, keys), prefix };
  };
}

/** What `remove` will do, said before it does any of it. */
function removalPlan(config: Config, name: string, prefix: string | null): string[] {
  const last = Object.keys(config.agents).length === 1;
  return [
    `Removing ${name} from this machine:`,
    last
      ? `  ${configPath()} is deleted, since ${name} is the last agent configured here`
      : `  its entry is removed from ${configPath()}`,
    `  ${mcpConfigPath(name)} is deleted`,
    prefix === null
      ? "  there is no key for it on this machine"
      : `  the key ${shownKey(prefix)} is forgotten on this machine and revoked in markdownbrain.ai`,
    "  a mdbrain run already running keeps the agent until it restarts",
    `${name} itself stays in markdownbrain.ai; it is deleted only on its own page there.`,
  ];
}

/** What `renew` will do, said before it does any of it. */
function renewalPlan(name: string, prefix: string | null): string[] {
  return [
    `Renewing ${name}'s connection key:`,
    "  a new key is requested from markdownbrain.ai and stored on this machine",
    prefix === null
      ? "  there is no key here for it to replace"
      : `  then the key it replaces, ${shownKey(prefix)}, is revoked in markdownbrain.ai`,
  ];
}

/**
 * Remove one agent's configuration from this machine, in the order the failure
 * cases want: the config first, so it never names a file that is gone; then the
 * connection file; then the revoke, which is best-effort; then the local key.
 *
 * @returns the lines to say, and false when nothing was removed
 */
async function removeAgent(
  deps: AgentsDeps,
  store: ConnectionKeyStore,
  config: Config,
  name: string,
): Promise<{ removed: boolean; lines: string[] }> {
  const entry = config.agents[name];
  // Read first, because it is needed after the key is forgotten.
  const held = await readHeld(store, entry.id);
  const prefix = held.kind === "key" ? held.prefix : null;

  const remaining = Object.fromEntries(Object.entries(config.agents).filter(([other]) => other !== name));
  try {
    if (Object.keys(remaining).length === 0) await deps.removeConfiguration();
    else await deps.saveConfiguration({ ...config, agents: Object.assign(Object.create(null), remaining) });
  } catch (cause) {
    return { removed: false, lines: [`${name} was not removed: the configuration could not be written (${(cause as Error).message}).`] };
  }
  const lines = [`${name} is no longer configured on this machine.`];
  try {
    await deps.removeMcpFile(name);
  } catch (cause) {
    lines.push(`  its connection file could not be deleted (${(cause as Error).message}); nothing reads it now.`);
  }

  // A deleted agent's keys went with it, so there is nothing to revoke and
  // asking would only be refused as *Agent not found*.
  const session = await deps.session();
  const token = session.kind === "ready" ? session.accessToken : null;
  let gone = false;
  if (token !== null) {
    const view = await deps.ownerView(token).catch(() => null);
    gone = view !== null && !view.agents.some((a) => a.id === entry.id);
  }
  if (held.kind === "unreadable") {
    // Not forgotten either: a key that could not be read cannot be named, so the
    // store is left as it is for the person to look at.
    lines.push(`  its key could not be read (${held.problem}), so it was neither revoked nor forgotten; check the agent's page for a key still live`);
    return { removed: true, lines };
  }
  if (prefix !== null) {
    lines.push(
      gone
        ? `  nothing to revoke: ${name} is gone from markdownbrain.ai, and its keys with it`
        : `  ${retirementSentence(await retireKey(deps, token, entry.id, prefix))}`,
    );
  }
  await store.forget(entry.id).catch(() => {});
  return { removed: true, lines };
}

/**
 * Mint a new key for one agent, store it and read it back, and only then retire
 * the one it replaces. A failure anywhere before the revoke leaves the old key
 * in place and live, so the worst case is two live keys and never none.
 */
async function renewAgent(
  deps: AgentsDeps,
  store: ConnectionKeyStore,
  name: string,
  entry: AgentEntry,
): Promise<{ renewed: boolean; lines: string[] }> {
  const session = await deps.session();
  if (session.kind === "stop") return { renewed: false, lines: [session.message] };
  const held = await readHeld(store, entry.id);
  // Stopped rather than minted past: a key that is there but unreadable would be
  // replaced without ever being revoked.
  if (held.kind === "unreadable") {
    return { renewed: false, lines: [`${name}'s key was not renewed: the key store could not be read (${held.problem}).`] };
  }
  const oldPrefix = held.kind === "key" ? held.prefix : null;
  let fresh: string;
  try {
    fresh = await deps.mint(session.accessToken, entry.id);
    await store.set(entry.id, fresh);
    if ((await store.get(entry.id)) !== fresh) {
      throw new Error("the key was stored, but reading it back did not return it, so this machine cannot use it");
    }
  } catch (cause) {
    const problem = redactSecrets((cause as Error).message).replace(/\.$/, "");
    const kept = oldPrefix === null ? "" : ` The key already here (${shownKey(oldPrefix)}) was kept.`;
    return { renewed: false, lines: [`${name}'s key was not renewed: ${problem}.${kept}`] };
  }
  const newPrefix = keyPrefixOf(fresh);
  const lines = [`${name} has a new connection key${newPrefix === null ? "" : ` (${shownKey(newPrefix)})`}, stored on this machine.`];
  if (oldPrefix !== null && oldPrefix !== newPrefix) {
    lines.push(`  ${retirementSentence(await retireKey(deps, session.accessToken, entry.id, oldPrefix))}`);
  }
  return { renewed: true, lines };
}

/**
 * The agent a subcommand names, or the sentence for why it names none.
 *
 * @param whole whether only the agent's whole name will do. The two writers ask
 *   for it: a prefix is a convenience for reading, and a typo that resolves to
 *   another agent is one that removes or revokes the wrong one.
 */
function pickAgent(typed: string | undefined, config: Config, whole = false): { name: string } | { problem: string } {
  const configured = Object.keys(config.agents);
  if (typed === undefined || typed === "") return { problem: AGENTS_USAGE };
  if (whole && !configured.includes(typed)) {
    const near = resolveAgent(typed, configured);
    const hint = near.kind === "one" ? ` It needs the whole name: did you mean ${near.name}?` : "";
    return { problem: `${notConfiguredMessage(typed, configured)}${hint}` };
  }
  const resolved = resolveAgent(typed, configured);
  if (resolved.kind === "one") return { name: resolved.name };
  if (resolved.kind === "many") return { problem: ambiguousAgentMessage(typed, resolved.matches) };
  return { problem: notConfiguredMessage(typed, configured) };
}

/**
 * The command, with its dependencies handed in.
 *
 * @returns 0 for a report, a browse, every agent accepted, or a removal or
 *   renewal that happened; 1 otherwise
 */
export async function runAgents(given: AgentsDeps, context: CommandContext): Promise<number> {
  const deps = { ...given, session: oneSessionAtATime(given.session) };
  const { out, err } = context;
  const [sub, typed] = context.positional;
  if (sub !== undefined && sub !== "check" && sub !== "remove" && sub !== "renew") {
    err(AGENTS_USAGE);
    return 1;
  }

  let store: ConnectionKeyStore;
  try {
    store = await deps.openKeyStore();
  } catch (cause) {
    err(`Could not open the connection key store: ${(cause as Error).message}`);
    return 1;
  }
  const at = locations(store, deps.env);

  const loaded = await deps.loadConfiguration();
  if (loaded.kind !== "config") {
    // The paths are the answer to *where is my configuration*, and that is
    // worth giving most of all when there is none.
    if (sub === undefined) for (const line of locationLines(at)) out(line);
    err(
      loaded.kind === "none" ? noConfigMessage(configPath()) : loaded.kind === "unreadable" ? UNREADABLE_CONFIG_MESSAGE : loaded.message,
    );
    return 1;
  }
  const config = loaded.config;

  if (sub === "check") {
    const names = typed === undefined ? Object.keys(config.agents) : null;
    let targets: string[];
    if (names !== null) targets = names;
    else {
      const picked = pickAgent(typed, config);
      if ("problem" in picked) {
        err(picked.problem);
        return 1;
      }
      targets = [picked.name];
    }
    const check = checker(deps, store);
    let allAccepted = true;
    for (const name of targets) {
      const { verdict, prefix } = await check(name, config);
      allAccepted &&= isAccepted(verdict);
      out(`${name}: ${verdictSentence(name, verdict, prefix)}`);
    }
    return allAccepted ? 0 : 1;
  }

  if (sub === "remove" || sub === "renew") {
    const picked = pickAgent(typed, config, true);
    if ("problem" in picked) {
      err(picked.problem);
      return 1;
    }
    if (context.flags.yes !== true) {
      if (!deps.isTTY) {
        err(needsYesMessage(sub));
        return 1;
      }
      const held = await readHeld(store, config.agents[picked.name].id);
      const prefix = held.kind === "key" ? held.prefix : null;
      const plan = sub === "remove" ? removalPlan(config, picked.name, prefix) : renewalPlan(picked.name, prefix);
      if (!(await deps.confirm(plan))) {
        err(sub === "remove" ? "Nothing removed." : "Nothing renewed.");
        return 1;
      }
    }
    const result =
      sub === "remove"
        ? await removeAgent(deps, store, config, picked.name)
        : await renewAgent(deps, store, picked.name, config.agents[picked.name]);
    const done = "removed" in result ? result.removed : result.renewed;
    for (const line of result.lines) (done ? out : err)(line);
    return done ? 0 : 1;
  }

  const prefixes = await heldPrefixes(config, store);
  if (!deps.isTTY) {
    for (const line of reportLines(at, config, (name) => mcpConfigPath(name), prefixes)) out(line);
    return 0;
  }

  // The browser reads the config again after every write, so its rows are
  // always what is on disk rather than what was there when it opened.
  let current = config;
  const rowsOf = async (now: Config): Promise<BrowserRow[]> => {
    const held = await heldPrefixes(now, store);
    return Object.entries(now.agents).map(([name, entry]) => {
      const prefix = held[entry.id] ?? null;
      return { name, lines: agentLines(name, entry, mcpConfigPath(name), prefix), heldPrefix: prefix === "unreadable" ? null : prefix };
    });
  };
  const reload = async (): Promise<Config> => {
    const again = await deps.loadConfiguration();
    current = again.kind === "config" ? again.config : { ...current, agents: Object.create(null) };
    return current;
  };
  const check = checker(deps, store);
  const prefixOf = (name: string) => {
    const held = current.agents[name] ? prefixes[current.agents[name].id] : null;
    return held === "unreadable" || held === undefined ? null : held;
  };
  // Set by `e`, and read once the browser has gone: the hand-over happens after
  // the browser's screen is torn down, so two Ink trees never share the terminal.
  let editing: string | null = null;
  await deps.browse({
    locations: locationLines(at),
    canEdit: (name) => current.agents[name] !== undefined,
    edit: (name) => {
      editing = current.agents[name]?.id ?? null;
    },
    rows: await rowsOf(config),
    check: async (name) => (await check(name, current)).verdict,
    renewPlan: (name) => renewalPlan(name, prefixOf(name)),
    removePlan: (name) => removalPlan(current, name, prefixOf(name)),
    renew: async (name) => {
      const result = await renewAgent(deps, store, name, current.agents[name]);
      Object.assign(prefixes, await heldPrefixes(current, store));
      return { lines: result.lines, rows: await rowsOf(current) };
    },
    remove: async (name) => {
      const result = await removeAgent(deps, store, current, name);
      const now = await reload();
      return { lines: result.lines, rows: await rowsOf(now) };
    },
  });
  if (editing !== null) return deps.configure(editing, context);
  return 0;
}

/** `mdbrain agents`, as the registry declares it. */
export const agents: CommandSpec = {
  name: "agents",
  summary: "show the agents this machine holds and whether each one's key works; check, renew or remove one",
  usage: "[check|remove|renew] [agent]",
  flags: [{ name: "yes", summary: "with remove or renew: go ahead without asking, for a script" }],
  run(context) {
    return runAgents(defaultDeps(), context);
  },
};

