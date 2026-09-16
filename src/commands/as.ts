// `mdbrain as <agent>` — start a session as one configured agent, with the
// person driving it.
//
// A triggered session and a session a person drives differ in exactly one thing
// that matters, and it is not the interface: one of them is bounded because
// nobody is watching. This command keeps every other part identical — the
// identity, the server grant, the checkout, the permission mode — and drops the
// boundedness, because `-p` is what the boundedness is made of.
//
// **It claims nothing, counts nothing and polls nothing.** No claim row is
// spent, so an attended session is invisible to every ceiling counted from that
// table, and nothing here is rate-limited: the ceilings exist to bound work
// nobody is watching, and there is no equivalent bound on a person at a keyboard.
//
// **It writes nothing, and that is a property rather than an implication.**
// `configure` creates the definition of what the agents are and holds the keys;
// this reads what `configure` already wrote and uses it to have one session
// represent one bot. No `config.json`, no per-agent MCP file, no draft, no key
// store, no `runs.jsonl`, no diagnosis log. The temptation that forecloses is
// repair: this is the command best placed to notice that a per-agent MCP file is
// stale or a key is missing, and exactly the command that must not fix either,
// because a consumer that quietly rewrites its input is a second writer — and
// two writers of one file is the hazard the whole configuration path is arranged
// to avoid. The cure for a stale file remains running `configure`.
//
// **It reads no roster, and so checks no human session.** The key on disk is
// sufficient and the MCP server authenticates the bot rather than the person, so
// this works on a machine whose human login has expired. The price is named
// where it is paid: an agent deleted on the server still starts a session here,
// and the refusal arrives from the MCP server at the first tool call instead.

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandSpec } from "../cli.ts";
import { loadConfig, mcpConfigPath } from "../config/store.ts";
import { configPath } from "../config/paths.ts";
import { openConnectionKeyStore, type ConnectionKeyStore } from "../config/secrets.ts";
import { ambiguousAgentMessage, resolveAgent } from "../as/choose.ts";
import { pickOnScreen } from "../as/screen.ts";
import { credentialsCollide, harnessFor } from "../run/harness.ts";
import { runAttached } from "../run/execute.ts";
import { holdReason } from "../run/loop.ts";
import { noConfigMessage, UNREADABLE_CONFIG_MESSAGE } from "./run.ts";

/**
 * What the command needs from outside itself, so a test can stand each one in.
 *
 * The same shape `run`'s deps have and for the same reason: the value of this
 * command is almost entirely in its *order*, and an order that can only be
 * exercised against a real configuration and a real harness is one nobody
 * exercises.
 */
export interface AsDeps {
  env: Record<string, string | undefined>;
  directoryExists: (path: string) => boolean;
  openKeyStore: () => Promise<ConnectionKeyStore>;
  loadConfiguration: typeof loadConfig;
  /** Hands the terminal to the session and answers how it ended. */
  startSession: typeof runAttached;
  /** Whether a person is at the terminal, and so whether a list can be asked. */
  isTTY: boolean;
  /** Draws the agents to choose between and answers with one, or null when the person left. */
  pickAgent: (options: string[], typed: string | null) => Promise<string | null>;
  /**
   * The session id, which is an edge because it is randomness.
   *
   * **Not a claim id and it must not be able to look like one.** `--session-id`
   * requires a valid UUID, so minting one is the whole of it.
   */
  newSessionId: () => string;
}

const defaultDeps: AsDeps = {
  env: process.env,
  directoryExists: (path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  },
  openKeyStore: () => openConnectionKeyStore(),
  loadConfiguration: loadConfig,
  startSession: runAttached,
  // Both streams, the way `configure` asks it: the list reads keys from one and
  // draws on the other, and a pipe on either is a terminal that cannot hold a
  // question.
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  pickAgent: (options, typed) => pickOnScreen(options, typed),
  newSessionId: () => randomUUID(),
};

/**
 * The usage sentence for an invocation that named no agent where no list can be
 * drawn.
 *
 * Reached only with nobody at the terminal: a person who types `mdbrain as` and
 * is there to read the answer is asked which agent instead. This is what is left
 * for a script, which cannot answer a question and needs telling what to write.
 */
export const USAGE_MESSAGE = "Usage: mdbrain as <agent>. Name one of the agents this machine is configured for.";

/** The refusal for a name that is not configured here, listing what is. */
export function unknownAgentMessage(name: string, configured: string[]): string {
  const known = configured.length === 0 ? "nothing is configured here" : `configured here: ${configured.join(", ")}`;
  return `${name} is not configured on this machine — ${known}. Run \`mdbrain configure\` to change that.`;
}

/**
 * The command, with its dependencies handed in.
 *
 * Each step's failure is one sentence and exit 1, in the shape `runRun` already
 * has, and the sentences are `run`'s own wherever one exists — reused rather
 * than retyped, so the two commands cannot develop two opinions about one
 * broken file.
 *
 * @returns the child's exit code once a session has started, and 1 for every
 * refusal before that
 */
export async function runAs(deps: AsDeps, context: CommandContext): Promise<number> {
  const { out, err } = context;

  const loaded = await deps.loadConfiguration();
  if (loaded.kind === "none") {
    err(noConfigMessage(configPath()));
    return 1;
  }
  if (loaded.kind === "unreadable") {
    err(UNREADABLE_CONFIG_MESSAGE);
    return 1;
  }
  if (loaded.kind === "problem") {
    err(loaded.message);
    return 1;
  }
  const config = loaded.config;

  const configured = Object.keys(config.agents);
  // **An empty name is a name that was not typed**, and the two have to arrive
  // here as one thing. A script writing `mdbrain as "$AGENT"` with the variable
  // unset passes an empty word rather than no word, and an empty string is a
  // prefix of every name — so on a machine holding one agent it would resolve to
  // that agent and start a real session the script never named, with exit 0 and
  // nothing said. Everything below reads *no name* off `null` alone, which is why
  // this is collapsed once here rather than guarded at each of them.
  const named = context.positional[0];
  const typed = named === undefined || named === "" ? null : named;

  // The list, or the sentence for a terminal that cannot hold one — in one place,
  // so that every way of arriving without a single agent leaves by the same door.
  const choose = async (matches: string[]): Promise<string | null> => {
    if (!deps.isTTY) {
      err(typed === null ? USAGE_MESSAGE : ambiguousAgentMessage(typed, matches));
      return null;
    }
    return deps.pickAgent(matches, typed);
  };

  // **A name that was not typed is never resolved, not even on a machine holding
  // exactly one agent.** `mdbrain as` and Enter would otherwise start a real
  // session on a real checkout with nothing asked, and the one-agent machine is
  // where that is both likeliest and least expected. Asking costs the person who
  // meant it one keypress, and costs the one who did not everything it saves.
  const resolved = typed === null ? { kind: "many" as const, matches: configured } : resolveAgent(typed, configured);
  if (resolved.kind === "none") {
    // Only reachable with a name actually typed: no name matches everything.
    err(unknownAgentMessage(typed ?? "", configured));
    return 1;
  }
  const agent = resolved.kind === "one" ? resolved.name : await choose(resolved.matches);
  // Nothing is said about leaving: the person who pressed Ctrl-C knows what they
  // did, and the exit code is what tells anything wrapping this that no session
  // happened. A terminal that could not be asked has already had its sentence.
  if (agent === null) return 1;

  const entry = config.agents[agent];
  if (entry === undefined) {
    err(unknownAgentMessage(agent, configured));
    return 1;
  }

  // **`holdReason` with a null roster, which is that function's existing
  // contract for *the roster is unknown*.** Two of its three reasons are exactly
  // this command's checks; the third needs a roster, the roster needs the human
  // session this command deliberately does not require, and it exists in `run`
  // to feed presence and to tell *renamed* from *gone*. Calling it with null is
  // what stops this command growing a second opinion about what makes an entry
  // unrunnable.
  const held = holdReason(agent, entry, deps.env, deps.directoryExists, null);
  if (held !== null) {
    err(`${agent} cannot start here: ${held}`);
    return 1;
  }

  const spec = harnessFor(entry.harness);

  let keyStore: ConnectionKeyStore;
  try {
    keyStore = await deps.openKeyStore();
  } catch (cause) {
    err(`Could not open the connection key store: ${(cause as Error).message}`);
    return 1;
  }

  // Refused before the key is read rather than after, because either resolution
  // of the collision is wrong: the harness would be handed a markdown-den
  // connection key as its model credential, or the MCP file's `${VAR}` would
  // expand to an Anthropic key.
  if (credentialsCollide(spec, entry.env.connectionKey)) {
    err(
      `${agent}'s connection key and its harness credential are both \`${spec.credentialVariable}\`. ` +
        "One variable cannot hold both; give the connection key its own name in config.json.",
    );
    return 1;
  }

  let connectionKey: string | null;
  try {
    connectionKey = await keyStore.get(entry.id);
  } catch (cause) {
    err(`The connection key could not be read: ${(cause as Error).message}`);
    return 1;
  }
  // Named as `configure`'s to fix rather than this command's: nothing here may
  // ask the server for a key, and it could not write one down if it were given
  // one.
  if (connectionKey === null) {
    err(`There is no connection key for ${agent} on this machine. Run \`mdbrain configure\` to ask the server for one.`);
    return 1;
  }

  const harnessCredential = entry.env.harness === null ? null : (deps.env[entry.env.harness] ?? null);
  if (entry.env.harness !== null && harnessCredential === null) {
    err(`${entry.env.harness} is no longer set, so the harness has no credential.`);
    return 1;
  }

  const spawnable = spec.buildInteractive({
    sessionId: deps.newSessionId(),
    mcpConfigPath: mcpConfigPath(agent),
    cwd: entry.cwd,
    harnessCredential,
    connectionKeyVariable: entry.env.connectionKey,
    connectionKey,
    parentEnv: deps.env,
  });

  // Nothing is printed before the harness takes the terminal. The harness draws
  // its own header and names the directory in it, the person just typed the
  // agent's name, and a line saying how this session differs from a triggered
  // one is a decision that has been taken the other way.
  const ending = await deps.startSession({ spawnable, cwd: entry.cwd });
  if (ending.spawnProblem !== null) {
    // Named for the harness rather than the errno, because `claude` not being on
    // PATH is the common one and `ENOENT` does not tell anybody that.
    err(`Could not start ${spec.id}: ${ending.spawnProblem}. Check that \`${spawnable.command}\` is on your PATH.`);
    return 1;
  }
  // **A signal is not an exit code, and must not be reported as one.** A child
  // ended by a signal has no code at all, and answering 0 for it would tell
  // anything wrapping this command that a harness which was killed — out of
  // memory, or crashed — finished its session cleanly. The signal is named
  // because by the time it is read the harness has already cleared the screen,
  // so the only account of what happened is this line.
  if (ending.exitCode === null) {
    err(`The session ended on ${ending.signal ?? "a signal"} rather than exiting.`);
    return 1;
  }
  // Otherwise whatever the child exited with, including the code the harness
  // uses when the person declines the workspace trust dialog.
  return ending.exitCode;
}

/** `mdbrain as`, as the registry declares it. */
export const as: CommandSpec = {
  name: "as",
  summary: "start a session as one configured agent",
  usage: "[agent]",
  run(context) {
    return runAs(defaultDeps, context);
  },
};
