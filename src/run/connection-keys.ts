// The connection keys a run works from, read once at the start and held for its life.
//
// **The read is per run rather than per unit, and that is the whole of this
// module.** A session used to ask the key store for its agent's key every time
// one started. macOS is the only backend with a per-item, per-application
// permission check, so on a machine whose keychain does not recognise this copy
// of the binary that read is what raises the password dialog — and a read per
// unit is a dialog per unit, arriving hours after the person who could answer it
// went away. That turns the one thing this program is for, being left alone,
// into the one thing it cannot do. Reading at the start moves the dialog to
// where somebody has just typed the command and is still standing there.
//
// **Holding the value costs very nearly nothing, and the reason is in the code
// rather than in an argument.** `childEnvironment` already puts the plaintext
// key into the environment of every session's child process, and each of those
// lives as long as the session does. What changes here is the lifetime of a
// variable inside a program that is already the key's custodian; what does not
// change is who can reach it.
//
// **What it does cost is staleness.** `mdbrain configure --new-keys` against a
// live run used to be picked up by the next session, because the next session
// re-read. {@link HeldKeys.rereadAfterFailure} is the answer to that, and its
// bound is the part worth reading before changing it.
//
// Pure of everything but the store it is handed: no clock, no disk, no process.

import type { ConnectionKeyStore } from "../config/secrets.ts";

/**
 * What the run holds for one agent.
 *
 * A failure is a value rather than a throw for the same reason every other
 * failure on the way to a session is: it has to reach the person as that unit's
 * own outcome, naming the agent it belongs to, rather than as a runner that
 * would not start. Reading the key earlier must not change what a missing or
 * unreadable one looks like when a unit finally arrives.
 */
export type HeldKey =
  | { kind: "key"; key: string }
  | { kind: "absent" }
  | { kind: "unreadable"; problem: string };

/** Every agent's connection key, as this run read them. */
export interface HeldKeys {
  /** What was read for this agent, without going near the store again. */
  held(agentId: string): HeldKey;
  /**
   * Drop what is held for this agent and read once more, because a unit just
   * failed in a way a wrong key would explain.
   *
   * **At most once for each agent in the whole run, and the bound is the design
   * rather than an optimisation.** Re-reading on every failure would put a
   * machine whose sessions fail for some reason that has nothing to do with the
   * key straight back to a dialog per unit, which is the failure this module
   * exists to end. One re-read is enough for the case it is for — a key renewed
   * while the runner was running — and a second renewal in one run is answered
   * by restarting the runner, which is what picks up the first one too.
   *
   * **Because there is only one, the caller has to spend it on a failure the
   * key could actually explain.** A session that could not be spawned, a prompt
   * that would not render, a harness credential that went away — none of those
   * say anything about the key, and a re-read spent on one of them is a re-read
   * not available to the renewal it exists for.
   */
  rereadAfterFailure(agentId: string): Promise<void>;
}

/**
 * What is held for an agent this run never read a key for.
 *
 * Unreachable as the program stands: only the agents `run` will ask for work
 * have a queue, and those are exactly the ids primed below. It is a value rather
 * than a throw because the alternative to naming the situation is handing a
 * session `null` and letting it fail somewhere that cannot say why.
 */
const NEVER_READ: HeldKey = {
  kind: "unreadable",
  problem: "this run holds no connection key for it, which should not be possible for an agent it asks for work",
};

/**
 * Read every agent's connection key now, and answer with what was read.
 *
 * @param store where the keys are kept
 * @param agentIds the agent **ids** — not names — whose keys this run will need
 */
export async function holdConnectionKeys(store: ConnectionKeyStore, agentIds: Iterable<string>): Promise<HeldKeys> {
  const held = new Map<string, HeldKey>();
  const alreadyReread = new Set<string>();

  // **Every read of the store goes through this, one at a time.** On macOS a
  // read can put a dialog in front of the person, and two raised together is a
  // stack of windows rather than a question — with a session blocked behind
  // each. Sessions for different agents run in parallel, so two of them failing
  // at the same moment is an ordinary Tuesday rather than a corner case, and
  // the startup reads share the lane for the same reason.
  let lane: Promise<unknown> = Promise.resolve();
  const read = (agentId: string): Promise<HeldKey> => {
    const next = lane.then(async (): Promise<HeldKey> => {
      try {
        const key = await store.get(agentId);
        return key === null ? { kind: "absent" } : { kind: "key", key };
      } catch (cause) {
        return { kind: "unreadable", problem: (cause as Error).message };
      }
    });
    // The lane must not inherit a rejection, or one bad read would poison every
    // read queued behind it. `next` cannot reject — the catch above is total —
    // but the guard costs nothing and does not depend on that staying true.
    lane = next.catch(() => {});
    return next;
  };

  // A duplicate id — two configured names pointing at one agent — is read once.
  for (const agentId of agentIds) {
    if (!held.has(agentId)) held.set(agentId, await read(agentId));
  }

  return {
    held: (agentId) => held.get(agentId) ?? NEVER_READ,
    rereadAfterFailure: async (agentId) => {
      if (alreadyReread.has(agentId)) return;
      // Marked before the read rather than after, so a read that throws still
      // spends the one attempt. Otherwise a store that fails every time would be
      // asked again on every failure, which is the unbounded case by another route.
      alreadyReread.add(agentId);
      held.set(agentId, await read(agentId));
    },
  };
}
