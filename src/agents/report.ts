// What `mdbrain agents` says about this machine, decided without a network.
//
// Every fact here already has a reader somewhere else in the program — where the
// config lives, which store holds the keys, what each entry asks for — and this
// is the one place that says them together, so a machine whose agents cannot
// connect can be diagnosed from outside. It is pure so the report can be
// asserted line by line.
//
// **A key appears only as its prefix.** The prefix is what the agent's page in
// the app shows, so it is enough to match the key on this machine to a row the
// owner can revoke, and it is never enough to use. `shownKey` is the only way a
// key reaches this text.

import type { AgentEntry, Config } from "../config/schema.ts";
import { shownKey } from "../config/secrets.ts";
import { harnessSentence, workSentence } from "../configure/questions.ts";

/** Where this machine keeps things, and what moved a root there. */
export interface Locations {
  configPath: string;
  stateDir: string;
  mcpDir: string;
  diagnosisPath: string;
  runLogPath: string;
  /** The key store's own sentence, from `keyStorageLine`. */
  keyStorage: string;
  /** Whether `MDBRAIN_CONFIG_DIR` put the config root where it is. */
  configMoved: boolean;
  /** Whether `MDBRAIN_STATE_DIR` put the state root where it is. */
  stateMoved: boolean;
}

/** The lines saying where things are, said whether or not anything is configured. */
export function locationLines(at: Locations): string[] {
  const moved = (yes: boolean, variable: string) => (yes ? ` (moved here by ${variable})` : "");
  return [
    `Configuration: ${at.configPath}${moved(at.configMoved, "MDBRAIN_CONFIG_DIR")}`,
    `State: ${at.stateDir}${moved(at.stateMoved, "MDBRAIN_STATE_DIR")}`,
    `Connection files: ${at.mcpDir}`,
    `Diagnosis log: ${at.diagnosisPath}`,
    `Runs log: ${at.runLogPath}`,
    at.keyStorage.trim(),
  ];
}

/**
 * One configured agent, as the report and the browser's right-hand pane show it.
 *
 * @param heldPrefix the prefix of the key this machine holds for it, or null for none
 */
export function agentLines(name: string, entry: AgentEntry, mcpPath: string, heldPrefix: string | null | "unreadable"): string[] {
  const { maxTurns, maxBudgetUsd, wallClock } = entry.bounds;
  return [
    name,
    `  id ${entry.id}`,
    `  harness ${entry.harness}, in ${entry.cwd}`,
    `  ${workSentence(entry)}`,
    `  ${harnessSentence(entry)}`,
    `  connection file ${mcpPath}`,
    `  bounds: ${maxTurns} turns, $${maxBudgetUsd}, ${wallClock} a session`,
    `  ${heldPrefix === null ? "no key on this machine" : heldPrefix === "unreadable" ? "the key store could not be read" : `key ${shownKey(heldPrefix)}`}`,
  ];
}

/** The whole plain report for a machine with a readable configuration. */
export function reportLines(
  at: Locations,
  config: Config,
  mcpPathFor: (name: string) => string,
  heldPrefixes: Readonly<Record<string, string | null | "unreadable">>,
): string[] {
  const lines = [...locationLines(at), ""];
  for (const [name, entry] of Object.entries(config.agents)) {
    lines.push(...agentLines(name, entry, mcpPathFor(name), heldPrefixes[entry.id] ?? null), "");
  }
  return lines.slice(0, -1);
}
