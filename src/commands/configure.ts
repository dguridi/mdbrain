// `mdbrain configure` — which agents this machine runs, and how each is started.
//
// A person's command, and it says so: with no terminal it refuses in one
// sentence and names the file to write by hand, because a screen with nothing
// to draw on is a hang rather than a fallback. Signed out, it runs the login
// itself and carries on rather than exiting — re-authenticating is a thing that
// happens on the way, not a wizard that begins with a login screen — which is
// why it declares the login's own flags: `--port` and `--no-browser` have to
// reach the login it runs, and be parsed as the login would parse them.
//
// The roster is read live every time, the way `whoami` reads it, because a
// configured agent's identity is a decision about the roster and not a copy of
// it. **It is filtered to the agents this account may manage** — the same right
// that governs adding and deleting an agent in the app's settings — because an
// agent this account cannot manage is one the server will not mint a key for,
// and offering it would offer an agent that cannot be run.
//
// What is written is the decision: the agents chosen, by name, with how each is
// invoked here. Nothing about what to watch — that is the brain's configuration,
// which this program never opens — and no secret. The one credential this
// command now holds, the agent's connection key, is **asked of the server and
// stored in this machine's key store**, never in the file: the server mints, and
// this program only receives.
//
// **The per-agent files are written before the config is.** The two are one
// write from the person's side and only the config's half is atomic, so the
// order is chosen for the failure that matters: a fault among the per-agent
// files leaves the old config in place and referring to nothing that is missing.
// The keys are asked for before either, because the network is the likeliest of
// the three to fail and a failure there is reported per agent rather than
// abandoning a configuration that is otherwise correct.
//
// Everything a test would want to vary is a dependency: the terminal check, the
// screen, the login, the environment, the key store. The command itself is only
// the order.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext, CommandSpec } from "../cli.ts";
import { AuthError, currentUser, listAgents, listMemberships, listOrganizations, mintAgentKey } from "../auth/api.ts";
import { signInAgainMessage } from "../auth/session.ts";
import { redactSecrets } from "../run/diagnosis.ts";
import { clearDraft, loadConfig, loadDraft, saveConfig, saveDraft, syncMcpConfigs } from "../config/store.ts";
import { configPath } from "../config/paths.ts";
import { keyStorageLine, openConnectionKeyStore, type ConnectionKeyStore } from "../config/secrets.ts";
import {
  agentChoices,
  assembleConfig,
  NOTHING_TO_MANAGE,
  organizationsWithoutAgents,
  ownedOrganizations,
  rosterAgents,
  summaryLines,
  withheldAgentsLine,
  type Answers,
  type KeyOutcome,
} from "../configure/questions.ts";
import { askOnScreen, type ScreenPlan } from "../configure/screen.ts";
import { login } from "./login.ts";
import { readySession } from "./session.ts";

/** What the command needs from outside itself, so a test can stand each one in. */
export interface ConfigureDeps {
  /** Whether a person is at the terminal. */
  isTTY: boolean;
  /** Draws the questions and answers with everything asked, or null when the person left. */
  ask: (plan: ScreenPlan) => Promise<Answers | null>;
  /** Runs the login flow, answering its exit code. */
  loginNow: (context: CommandContext) => Promise<number>;
  env: Record<string, string | undefined>;
  currentDirectory: string;
  isDirectory: (path: string) => boolean;
  /** The sub-directories of an absolute path, for the directory question's Tab completion. */
  listDirectory: (path: string) => string[];
  /** Where a received connection key is kept. */
  openKeyStore: () => Promise<ConnectionKeyStore>;
}

/** The sentence for a `configure` with nobody at the terminal. */
export function noTerminalMessage(path: string): string {
  return `mdbrain configure needs a terminal to ask its questions. Write ${path} by hand, or copy one from a configured machine.`;
}

/**
 * The sentence for an owner whose organizations simply hold no agent yet.
 *
 * A different fact from `NOTHING_TO_MANAGE` and it must not borrow its words: being
 * told about ownership when the remedy is *create an agent* sends a person to
 * look at their permissions for something that is not there.
 */
export function nothingYetMessage(organizations: string[]): string {
  return organizations.length > 0
    ? `No agents yet in ${organizations.join(", ")}, so there is nothing to configure. Create one in markdown-den first.`
    : "No agents are visible to this account, so there is nothing to configure. Create one in markdown-den first.";
}

/**
 * Make sure every chosen agent has a connection key on this machine, asking the
 * server for the ones that are missing.
 *
 * A key already stored is kept rather than replaced: minting is cheap but a
 * second key is a second live credential, and a `configure` re-run to change a
 * directory should not quietly leave one behind. A failure is recorded against
 * the agent it belongs to and does not stop the rest — the configuration is
 * still correct without it, and the summary says what to do.
 */
async function ensureConnectionKeys(
  store: ConnectionKeyStore,
  accessToken: string,
  agents: Array<{ name: string; id: string }>,
  renew: boolean,
): Promise<Record<string, KeyOutcome>> {
  const outcomes: Record<string, KeyOutcome> = {};
  for (const agent of agents) {
    try {
      if (!renew && (await store.get(agent.id))) {
        outcomes[agent.name] = { kind: "held" };
        continue;
      }
      // Minted before it is stored, deliberately: a mint that fails must leave
      // the key already here intact, since it may be the working one.
      const key = await mintAgentKey(accessToken, agent.id);
      await store.set(agent.id, key);
      outcomes[agent.name] = { kind: renew ? "renewed" : "minted" };
    } catch (cause) {
      outcomes[agent.name] = { kind: "failed", problem: (cause as Error).message };
    }
  }
  return outcomes;
}

/** The flag that mints again for an agent this machine already holds a key for. */
const NEW_KEYS_FLAG = "new-keys";

/**
 * The command, with its dependencies handed in.
 *
 * The order is the design: terminal, session (login inline if none), roster and
 * the account's own roles, the questions, the keys, the write, the summary. A
 * refusal anywhere is one sentence and exit 1, and nothing is written before the
 * last question is answered — except the draft, which is written as the answers
 * are given so that quitting part-way costs keystrokes rather than work.
 */
export async function runConfigure(deps: ConfigureDeps, context: CommandContext): Promise<number> {
  const { out, err } = context;
  if (!deps.isTTY) {
    err(noTerminalMessage(configPath()));
    return 1;
  }

  let session = await readySession();
  if (session.kind === "stop" && session.reason !== "unreachable") {
    // Signed out, or a session the server has ended: the login is what is
    // needed, so it runs here and the questions follow in the same command.
    out(session.message);
    out("");
    const code = await deps.loginNow(context);
    if (code !== 0) return code;
    out("");
    session = await readySession();
  }
  if (session.kind === "stop") {
    err(session.message);
    return 1;
  }

  const loading = loadConfig();
  const loadingDraft = loadDraft();
  let roster;
  let emptyOrganizations: string[];
  let withheld: string | null;
  // Every agent this account can *see*, which is a wider set than the one it may
  // manage. It is what tells a configured entry that has been deleted from an
  // entry whose organization this account no longer owns.
  let stillVisible = new Set<string>();
  // Whether this account owns any organization at all, which is what tells an
  // owner with no agents from a member with no rights.
  let ownsSomething = false;
  try {
    const me = await currentUser(session.accessToken);
    if (!me.id) throw new Error("the server did not say which account this session belongs to");
    const [organizations, agents, memberships] = await Promise.all([
      listOrganizations(session.accessToken),
      listAgents(session.accessToken),
      listMemberships(session.accessToken, me.id),
    ]);
    const owned = ownedOrganizations(organizations, memberships);
    roster = rosterAgents(owned, agents);
    emptyOrganizations = organizationsWithoutAgents(owned, agents);
    withheld = withheldAgentsLine(agents.length - roster.length);
    stillVisible = new Set(agents.map((a) => a.id));
    ownsSomething = owned.length > 0;
  } catch (cause) {
    const refused = cause instanceof AuthError ? signInAgainMessage(cause.status, "mdbrain configure") : null;
    // Redacted for the reason the roster read in `run` is: the body belongs to
    // whatever answered, and a proxy that echoes the request echoes the bearer
    // with it.
    const detail = redactSecrets((cause as Error).message);
    err(refused ? `${refused} (the server said: ${detail})` : `Could not read the roster: ${detail}`);
    return 1;
  }
  if (roster.length === 0) {
    // Two different empty lists. An owner with no agents yet needs to create
    // one; someone who owns nothing needs a different sentence, and the two are
    // told apart by whether any organization was offered at all.
    err(ownsSomething ? nothingYetMessage(emptyOrganizations) : NOTHING_TO_MANAGE);
    return 1;
  }

  const loaded = await loading;
  if (loaded.kind === "unreadable") out(`The configuration at ${configPath()} could not be read, so this starts from nothing.`);
  if (loaded.kind === "problem") out(`The configuration at ${configPath()} was refused (${loaded.message}), so this starts from nothing.`);
  const existing = loaded.kind === "config" ? loaded.config : null;
  const draft = await loadingDraft;
  if (draft) out("Picking up the answers a configure that did not finish left behind; every question is asked again, offering them.");

  const choices = agentChoices(roster, existing, stillVisible);
  const plan: ScreenPlan = {
    choices,
    emptyOrganizations,
    withheld,
    existing,
    draft,
    currentDirectory: deps.currentDirectory,
    env: deps.env,
    isDirectory: deps.isDirectory,
    listDirectory: deps.listDirectory,
    // Fire and forget: a draft that cannot be written must not interrupt a
    // question, and the next read simply finds nothing to offer.
    record: (d) => void saveDraft(d),
  };

  const answers = await deps.ask(plan);
  if (!answers) {
    err("Nothing written.");
    return 1;
  }

  const store = await deps.openKeyStore();
  const keys = await ensureConnectionKeys(store, session.accessToken, answers.agents, context.flags[NEW_KEYS_FLAG] === true);

  const config = assembleConfig(answers);
  try {
    const { mcpPaths, removed } = await syncMcpConfigs(config);
    const path = await saveConfig(config);
    // After the write and outside its failure: a draft that will not delete is
    // a stale convenience, and reporting it as a configuration that could not be
    // written would be a lie about the file that is now on disk.
    await clearDraft().catch(() => {});
    for (const line of summaryLines(config, { path, mcpPaths, removed }, choices.disappeared, answers.dropped, keys)) out(line);
    out(keyStorageLine(store.backend));
  } catch (cause) {
    err(`The configuration could not be written: ${(cause as Error).message}`);
    return 1;
  }
  return 0;
}

/** Whether a path is a directory that exists — one stat, and absence is an answer rather than an error. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/**
 * The sub-directories of a path, for completion.
 *
 * Directories only, since the question asks for one. A path that cannot be read
 * — gone, or not permitted — answers with nothing rather than raising: Tab
 * offering no completion is the right behaviour for a directory that is not
 * there, and an exception would take the screen down mid-question.
 */
function listDirectory(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => {
        if (entry.isDirectory()) return true;
        // A symlink's type is not resolved by `withFileTypes`, so a link to a
        // directory would be dropped without this second look.
        if (!entry.isSymbolicLink()) return false;
        return isDirectory(join(path, entry.name));
      })
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export const configure: CommandSpec = {
  name: "configure",
  summary: "choose which agents this machine runs, and how each is started",
  // The login's flags, because the login can run inside this command and its
  // `--port` takes a value: a flag not declared here would be parsed as bare and
  // refused by the login for the exact form the person typed. Plus this
  // command's own one, which is the only way out of a key that no longer works:
  // a key the store holds is otherwise kept for good, and a key revoked in the
  // app looks identical from here to one that works.
  flags: [
    ...(login.flags ?? []),
    { name: NEW_KEYS_FLAG, summary: "mint new connection keys, replacing any this machine already holds" },
  ],
  run(context) {
    return runConfigure(
      {
        isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
        ask: askOnScreen,
        loginNow: (ctx) => login.run(ctx),
        env: process.env,
        currentDirectory: process.cwd(),
        isDirectory,
        listDirectory,
        openKeyStore: () => openConnectionKeyStore(),
      },
      context,
    );
  },
};
