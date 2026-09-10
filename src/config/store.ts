// Reading and writing the runner's own configuration, and the one file written
// beside it per agent.
//
// Thin on purpose, as the session store is: what the file MEANS is decided in
// `schema.ts`, which has no disk in it. Here are the operations that touch the
// filesystem, and the two things they must get right. The config is written
// **atomically** — to a sibling temporary file, then renamed over the real one —
// so a `configure` interrupted mid-write leaves the old file whole rather than a
// half-written new one. And it is written with ordinary permissions, deliberately:
// it holds no secret and is meant to be copied.
//
// The per-agent MCP file is what the harness is pointed at to reach the
// workspace as that agent. **Its contents are the harness's and are written by
// the harness spec**; what belongs here is where the file goes, when it is
// rewritten, and when a stale one is swept. It carries the connection key as `${VARIABLE}` — the
// variable's name, which the harness expands from the session's environment —
// and never the value, so it can sit under the config root and travel with it.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir, configPath, type PathEnv } from "./paths.ts";
import { newAgentMap, parseConfig, serializeConfig, type Config } from "./schema.ts";
import { harnessFor, type HarnessSpec } from "../run/harness.ts";
import { DRAFT_VERSION, mcpFileNameFor, parseDraft, type ConfigureDraft } from "../configure/questions.ts";

/** What was on disk, with the two failures told apart from absence. */
export type LoadedConfig =
  | { kind: "config"; config: Config }
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "problem"; message: string };

/**
 * Read the configuration.
 *
 * *Absent*, *there but not readable* and *readable but refused* are three
 * answers, because they read differently to a person: run `configure`; something
 * is wrong with the file; and here is the field that is wrong.
 */
export async function loadConfig(env?: PathEnv): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(configPath(env), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable" };
  }
  const reading = parseConfig(text);
  return reading.kind === "config" ? { kind: "config", config: reading.config } : { kind: "problem", message: reading.message };
}

/**
 * Write the configuration, replacing whatever was there — all at once or not at
 * all.
 *
 * The temporary file sits beside the real one so the rename is within one
 * directory, which is the only rename a filesystem promises to be atomic. The
 * directory is created if it is not there, since a first configure is the
 * common case.
 */
export async function saveConfig(config: Config, env?: PathEnv): Promise<string> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, serializeConfig(config), "utf8");
  await rename(temporary, path);
  return path;
}

/** Where a `configure` in progress records what has been answered so far. */
export function draftPath(env?: PathEnv): string {
  return join(configDir(env), "configure-draft.json");
}

/** The draft left by a `configure` that did not finish, or null when there is none to offer. */
export async function loadDraft(env?: PathEnv): Promise<ConfigureDraft | null> {
  try {
    return parseDraft(await readFile(draftPath(env), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Record what has been answered so far.
 *
 * Called after every accepted answer, so it must never be the reason a question
 * fails: a draft that cannot be written is a lost convenience, not a lost
 * configuration, and the sequence carries on without it. It is deliberately not
 * atomic for the same reason — a torn draft is discarded at the next read.
 */
export async function saveDraft(draft: ConfigureDraft, env?: PathEnv): Promise<void> {
  try {
    const path = draftPath(env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ ...draft, version: DRAFT_VERSION }, null, 2)}\n`, "utf8");
  } catch {
    // Nothing to say and nothing to do: the questions are what matter.
  }
}

/** Forget the draft, once the answers it held have been written for real. */
export async function clearDraft(env?: PathEnv): Promise<void> {
  await rm(draftPath(env), { force: true });
}

/** The folder the per-agent MCP files live in. */
export function mcpDir(env?: PathEnv): string {
  return join(configDir(env), "mcp");
}

/** Where the harness is pointed at for one agent's workspace connection. */
export function mcpConfigPath(agentName: string, env?: PathEnv): string {
  return join(mcpDir(env), mcpFileNameFor(agentName));
}

/**
 * Write one agent's MCP file, creating the folder on the first agent.
 *
 * **The text comes from the harness, not from here.** What that file contains is
 * the harness's question — which keys it carries, and whether it is JSON at all —
 * and this module's question is only where it goes and when it is rewritten.
 * The spec is passed rather than defaulted, so a caller cannot write one
 * harness's file for an agent that named another.
 */
export async function writeMcpConfig(
  agentName: string,
  connectionKeyVariable: string,
  harness: HarnessSpec,
  env?: PathEnv,
): Promise<string> {
  const path = mcpConfigPath(agentName, env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, harness.mcpConfigText(connectionKeyVariable), "utf8");
  return path;
}

/**
 * Bring the MCP files into step with a config: one per configured agent, and
 * none for an agent no longer configured here.
 *
 * Called BEFORE the config is saved, because the two are one write from the
 * person's side and only the config's half is atomic: writing the per-agent
 * files first means a failure among them leaves the old config in place and
 * nothing referring to a file that does not exist, while a failure of the
 * config's rename leaves extra files that nothing reads. The stale files go so
 * a deselected agent's connection does not sit on disk under the config root
 * indefinitely, and each removal is reported rather than silent.
 *
 * @returns the file each agent got, and the stale files removed
 */
export async function syncMcpConfigs(config: Config, env?: PathEnv): Promise<{ mcpPaths: Record<string, string>; removed: string[] }> {
  // Prototype-less for the reason `newAgentMap` gives: an agent named
  // `__proto__` would otherwise leave no key here, so the file just written for
  // it would be absent from `keep` and removed again as though it were stale.
  const mcpPaths = newAgentMap() as unknown as Record<string, string>;
  for (const [name, entry] of Object.entries(config.agents)) {
    mcpPaths[name] = await writeMcpConfig(name, entry.env.connectionKey, harnessFor(entry.harness), env);
  }
  // The sweep still knows one file shape — `agent-*.json` — which is the half of
  // this seam that has NOT moved. It is correct while every harness writes JSON
  // under that name, and the day one does not, two harnesses on one machine will
  // want two shapes and this set will be deciding for both of them. Left as it is
  // deliberately rather than generalised against a second harness nobody has.
  const keep = new Set(Object.values(mcpPaths));
  const removed: string[] = [];
  for (const file of await readdir(mcpDir(env))) {
    const path = join(mcpDir(env), file);
    if (file.startsWith("agent-") && file.endsWith(".json") && !keep.has(path)) {
      await rm(path, { force: true });
      removed.push(path);
    }
  }
  return { mcpPaths, removed };
}
