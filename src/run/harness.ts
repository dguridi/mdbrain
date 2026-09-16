// The seam between the runner and whatever coding agent it starts, and the one
// implementation behind it.
//
// **The property this seam exists to hold: a session is pinned to one identity
// and never inherits the human's local MCP configuration**, because the
// private-folder wall is per identity. `--strict-mcp-config` is Claude Code's way
// of holding it; it is not the rule, and a second harness holds the same property
// with whatever its own command line offers. Each implementation is responsible
// for it, and the guarantee is one test asserting the flags are there and this
// comment saying why — no enforcement scaffolding beyond that, because strict is
// the default and nobody is attacking it.
//
// The other half of the same property is that the config file refuses a
// `command` field, which is the only other place a session could be pointed
// somewhere else by editing text.
//
// **The session is also granted that one server's tools, and nothing else.**
// Supplying a server and withholding permission to call it is the same as
// supplying nothing: an unattended session has nobody to ask, so it stops at
// its first tool call having spent real money and done no work. The grant is
// therefore part of handing the server over rather than a permission policy —
// it names the server this file supplied, and it cannot reach a server that was
// not supplied.
//
// **Everything the harness itself can do is decided by the permission mode, and
// for an unattended session the mode is chosen for a room with nobody in it.**
// The two flags that do that are `--permission-mode auto` and
// `--permission-prompts none`, each argued at the line it appears on. The
// property they hold together is that an unattended session never ends its turn
// asking a person for something: either the action is approved, or the session
// is told nobody can answer and carries on without it.
//
// **Two kinds of session are built here, and they differ in exactly one thing.**
// An identity — who a session is and what it may reach — is the same whether a
// person is watching or not, so it is one function, `identityArgs`, that both
// builders spread. What an unattended session adds on top is an instruction and
// the bounds on it; an attended session adds nothing at all, because the bounds
// are what having nobody watching is made of and a person ends their own session.
// Keeping the shared half a function rather than a discipline is the whole point:
// a flag can then only reach one mode by being added to that mode deliberately,
// in a diff that says so.
//
// Pure: both builders take values and answer argv and an environment. Nothing
// here spawns anything, which is what lets every flag be asserted without a
// process.

import { MCP_SERVER_NAME, MCP_URL } from "../auth/project.ts";
import type { Bounds, HarnessId } from "../config/schema.ts";
import { readOutcome, type Outcome, type SessionEnd } from "./outcome.ts";

/**
 * Who a session is and what it may reach — the same in both modes.
 *
 * Every field here is settled before anyone decides whether a person is
 * watching, which is what makes it the shared half rather than a subset that
 * happens to overlap today.
 */
export interface Identity {
  /**
   * The harness's `--session-id`, which names the transcript on this machine.
   *
   * **Not called `claimId`, because an attended session has no claim.** A field
   * naming a thing one of its two callers does not have is a name that has to be
   * filled in with something, and what gets filled in is a lie the type signs
   * off on. `run` passes its claim id, so a transcript here and a row on the
   * server still share one name; `as` mints a UUID of its own.
   */
  sessionId: string;
  /** The per-agent MCP file, which names the connection key's variable. */
  mcpConfigPath: string;
  cwd: string;
  /**
   * The value for the harness's own credential, or null for the machine's own
   * signed-in account — in which case the variable is **removed** from the
   * child rather than left alone.
   */
  harnessCredential: string | null;
  /** The variable the MCP file expands the connection key from. */
  connectionKeyVariable: string;
  connectionKey: string;
  /** The runner's own environment, which the child inherits but for the two below. */
  parentEnv: Record<string, string | undefined>;
}

/**
 * An unattended session: an identity, an instruction, and the bounds on it.
 *
 * The two added fields are exactly what having nobody watching is made of — a
 * session nobody asked for needs to be told what to do, and one nobody is
 * watching needs an outer edge.
 */
export interface Invocation extends Identity {
  /** The instruction's prompt, byte for byte. Nothing is prepended or appended. */
  prompt: string;
  bounds: Bounds;
}

/** What to spawn. */
export interface Spawnable {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** One coding harness this build can start. */
export interface HarnessSpec {
  id: HarnessId;
  /** The variable the harness itself reads its credential from. */
  credentialVariable: string;
  /**
   * The MCP configuration file this harness reads, as text.
   *
   * On the spec rather than in the config store because the file format is the
   * harness's, not the protocol's: what keys it carries and whether it is JSON
   * at all differ per harness, and a store that wrote one shape for all of them
   * would be a Claude assumption with a general name on it.
   */
  mcpConfigText(connectionKeyVariable: string): string;
  /**
   * The flags that say who a session is and what it may reach, in both modes.
   *
   * **The name covers the tool boundary as well as the identity**, and that is
   * deliberate rather than loose: `--permission-mode` is in the set and is not
   * an identity flag in the narrow sense. It is here because *what may this bot
   * do* is as much the question an attended session exists to show as *who is
   * it*, and because a flag that survived into one mode and not the other is
   * precisely the drift this function exists to make impossible.
   */
  identityArgs(identity: Identity): string[];
  build(input: Invocation): Spawnable;
  /** An attended session: the identity, and deliberately nothing else. */
  buildInteractive(identity: Identity): Spawnable;
  readOutcome(end: SessionEnd): Outcome;
}

/**
 * The child's environment: the runner's, with one substitution and one removal.
 *
 * The substitution is the connection key, which reaches the harness through the
 * variable the MCP file names. The removal is the harness's own credential
 * variable when the configuration chose the machine's own account — deleted
 * rather than left unset, because a key the shell happens to export would
 * otherwise silently stand in for the account that was chosen, and the session
 * would run as somebody else with nothing on screen to say so.
 */
export function childEnvironment(input: Identity, credentialVariable: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.parentEnv)) {
    if (value !== undefined) env[name] = value;
  }
  // The removal happens first and the connection key is set after it, so the two
  // cannot cancel each other out. A hand-written config naming the harness's own
  // variable as `env.connectionKey` would otherwise have its key deleted a line
  // after it was set, and every session for that agent would fail at the MCP
  // connection with nothing on screen explaining why. `credentialsCollide`
  // refuses that configuration outright; this ordering is the second lock.
  if (input.harnessCredential === null) {
    delete env[credentialVariable];
  } else {
    env[credentialVariable] = input.harnessCredential;
  }
  env[input.connectionKeyVariable] = input.connectionKey;
  return env;
}

/**
 * Whether an entry points both credentials at one variable.
 *
 * Refused rather than resolved, because either resolution is wrong: the harness
 * would be handed a markdown-den connection key as its model credential, or the
 * MCP file's `${VAR}` would expand to an Anthropic key. `configure` never writes
 * this, but `config.json` is a first-class hand-written input and the schema
 * cannot see it — the harness's own variable name is this module's, not the
 * schema's.
 */
export function credentialsCollide(spec: HarnessSpec, connectionKeyVariable: string): boolean {
  return connectionKeyVariable === spec.credentialVariable;
}

/**
 * Claude Code's MCP configuration file, as text.
 *
 * **Named for the format it writes rather than for the protocol.** The shape
 * below — a `mcpServers` object, an `http` type, a bearer header — is Claude
 * Code's file and not a general MCP one: another harness reading the same
 * server will want its own keys, and one of them wants TOML rather than JSON.
 * The seam is here, beside the argv this harness is started with and the
 * credential variable it reads, because that is where the rest of the Claude
 * assumptions live and where somebody adding a second harness will look.
 *
 * The header names the variable rather than carrying the key, in the `${NAME}`
 * form the harness expands from its environment. The file is therefore not a
 * secret, which is what allows it to live under the config root.
 *
 * @param connectionKeyVariable the environment variable holding this agent's key
 * @returns the file's whole text, newline-terminated
 */
export function claudeMcpConfigText(connectionKeyVariable: string): string {
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: MCP_URL,
        headers: { Authorization: `Bearer \${${connectionKeyVariable}}` },
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Claude Code, the one harness this build has. */
export const claudeHarness: HarnessSpec = {
  id: "claude",
  credentialVariable: "ANTHROPIC_API_KEY",
  mcpConfigText: claudeMcpConfigText,

  identityArgs(identity) {
    return [
      "--mcp-config",
      identity.mcpConfigPath,
      // Not tidiness. Without it the session also loads whatever MCP
      // configuration the person has on this machine, which hands the agent a
      // second workspace connection under a different identity.
      //
      // **It bounds configured servers and not the harness's own built-ins.** An
      // attended session starts in-process servers of Claude Code's that this
      // flag does not reach and no flag bounds on its own, so the tool surface a
      // person sees in an attended session is wider than an unattended one's.
      // The identity wall still holds — none of them is a second markdown-den
      // connection — but *the bot can do exactly this much* is not a question an
      // attended session answers on its own.
      "--strict-mcp-config",
      // The other half of handing a session an MCP server: a server it may
      // not call is a server it does not have. Nothing in `-p` can ask a
      // person to approve a tool, so an unattended session that needs one stops
      // and says so, having spent real money and done nothing.
      //
      // **This grants exactly the server the line above supplied and nothing
      // else** — the name is the key `store.ts` writes, and `--strict-mcp-config`
      // means no other configured server is loaded to be caught by it. It is
      // kept even though the mode below would send these calls to a classifier
      // that would very likely approve them: an allow rule is decided before the
      // classifier is consulted, so this is one fewer round trip per call and
      // one fewer judgement to be surprised by.
      "--allowedTools",
      `mcp__${MCP_SERVER_NAME}`,
      // **`auto` rather than `acceptEdits`, because the runner's whole purpose
      // is work nobody is watching.** `acceptEdits` auto-approves reads, edits
      // in the working directory and a handful of filesystem commands; every
      // other shell command needs a rule, so a session asked to run the tests
      // or open a pull request stops at its first command. `auto` sends what
      // is left to the classifier, which approves ordinary development and
      // refuses a defined dangerous set — force pushes, destructive git,
      // production deploys, sending secrets outward, downloading and executing
      // code. That is a real boundary rather than none, which is why this is
      // not `bypassPermissions`: nothing here is an isolated container, it is
      // somebody's own checkout.
      //
      // Two prices, stated because neither is visible from the flag: the
      // classifier is a round trip before some calls run, and on API-key
      // accounts its calls count towards the same budget `--max-budget-usd`
      // bounds.
      //
      // **It is shared rather than per-mode because the mode is the answer to
      // what this bot may do**, which is the question both callers are asking.
      // What differs is only who is there to be asked when the classifier
      // declines, and that is the flag below this set rather than this one.
      "--permission-mode",
      "auto",
      // The transcript's name. `run` passes its claim id, so a transcript here
      // and a row on the server share one name without a lookup table; an
      // attended session passes a UUID minted for it.
      "--session-id",
      identity.sessionId,
    ];
  },

  build(input) {
    return {
      command: "claude",
      args: [
        // The prompt travels verbatim: the brain said what to do, and that is
        // what the session is told. Nothing before it and nothing after it.
        "-p",
        input.prompt,
        ...claudeHarness.identityArgs(input),
        // **What an unattended session does when it is refused anyway.** Without
        // this a refusal is still a refusal, but the session is not told why, and
        // it ends its turn asking a person to approve something — which is how
        // sessions came to cost money and do nothing. With it the session is
        // told that nobody can answer and not to retry, `AskUserQuestion` is
        // removed from it entirely, and it carries on with what it can do.
        //
        // It is why this program needs Claude Code 2.1.259 or newer: an older
        // one refuses the flag by name, and every session fails at spawn rather
        // than quietly reverting to asking.
        //
        // **It is in this builder and not the shared set because it answers a
        // question only an empty room asks.** An attended session has somebody
        // to put the refusal to, which is the whole difference between the two.
        "--permission-prompts",
        "none",
        // `json` and not `stream-json`: one result object at the end. The live
        // view's spinner attests that the process is alive and claims nothing
        // about progress, precisely because nothing is said until this arrives.
        "--output-format",
        "json",
        "--max-turns",
        String(input.bounds.maxTurns),
        "--max-budget-usd",
        String(input.bounds.maxBudgetUsd),
      ],
      env: childEnvironment(input, claudeHarness.credentialVariable),
    };
  },

  buildInteractive(identity) {
    return {
      command: "claude",
      // **The identity and nothing else**, which is the whole of what an
      // attended session is. No `-p`, so the harness draws its own screen and
      // reads its own keys; no `--output-format`, because there is no result
      // object to parse; and none of the three bounds, because every one of them
      // is either print-gated at the harness or enforced by the runner's own
      // wall clock, and an attended session has neither. It is not bounded here:
      // the person ends it.
      args: claudeHarness.identityArgs(identity),
      env: childEnvironment(identity, claudeHarness.credentialVariable),
    };
  },

  readOutcome,
};

/** Every harness this build has, by the id the config names. */
export const HARNESSES: Record<HarnessId, HarnessSpec> = { claude: claudeHarness };

/** The harness an entry names. The schema has already refused anything else. */
export function harnessFor(id: HarnessId): HarnessSpec {
  return HARNESSES[id];
}
