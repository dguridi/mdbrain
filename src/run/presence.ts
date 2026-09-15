// When an agent should be in a brain's roster, and when it should leave.
//
// Pure, and it is the whole of the decision: the socket beside it only carries
// out the joins and leaves this produces. That split is what lets the one
// behaviour most likely to be got wrong be asserted without a network.
//
// **Presence is driven off the runner's `running` flag and never off the
// `start`/`done` event pair.** Between two queued units the flag goes false and
// true again synchronously, with no observable gap, while the events go `done`
// then `start` with a real gap between them. A publisher that joined on `start`
// and left on `done` would make an agent working through a queue leave and
// rejoin the roster between every unit — a flickering dot in production, and
// nothing at all in a test, which is why the rule is written down here rather
// than left to be discovered.
//
// So the input is a *desired set*, recomputed from the flags after anything
// changes, rather than a stream of transitions. The linger below is what absorbs
// the momentary false between two units of one stretch.

import { botPresencePayload, type BotPresencePayload } from "@markdown-den/collab-core";

/**
 * How long an agent stays in the roster after its last unit ends.
 *
 * Long enough that a unit arriving behind the one that just finished leaves the
 * session standing, and short enough that a run which is genuinely over stops
 * claiming to be working. It absorbs the gap between two units of one stretch;
 * it is not a grace period for a dead runner, which is the socket's own
 * heartbeat's business.
 */
export const PRESENCE_LINGER_MS = 5_000;

/**
 * The agent's presence payload, with no file.
 *
 * **Null is deliberate rather than missing.** A harness session's wall-clock is
 * mostly thinking, reading and running tests, which is not a place in a
 * document — and the file tree skips any session whose file is null, so this is
 * exactly what puts the agent in the roster and no dot on the tree. Everything
 * else, the colour included, comes from the builder both publishers share.
 */
export function presencePayload(sessionKey: string, userId: string, name: string): BotPresencePayload {
  return botPresencePayload({ sessionKey, userId, name, activeFileId: null });
}

/**
 * The key this runner tracks presence under for one agent.
 *
 * Unique per process so two runners running the same agent are two roster
 * memberships rather than one they fight over, and stable across a reconnect so
 * a dropped socket coming back is the same session rather than a second one.
 *
 * @param nonce this process's own nonce, generated once at startup
 */
export function presenceKeyFor(nonce: string, userId: string): string {
  return `runner-${nonce}-${userId}`;
}

/** Where one agent stands: the brain it is present in, and when it may leave. */
export interface PresenceEntry {
  workspace: string;
  /** The moment the linger runs out, or null while the agent is still working. */
  leaveAt: number | null;
}

/** Every agent this runner is publishing for, by its configured name. */
export type PresenceLedger = ReadonlyMap<string, PresenceEntry>;

/** What the socket has to do about a change. */
export type PresenceAction =
  | { kind: "join"; agent: string; workspace: string }
  | { kind: "leave"; agent: string; workspace: string };

/** A ledger publishing for nobody. */
export const emptyLedger: PresenceLedger = new Map<string, PresenceEntry>();

/**
 * The ledger after comparing it with what should be true now.
 *
 * Called on every change to the running flags **and** on a timer, because a
 * linger expiring is a change nothing else announces. The two cases are one
 * function on purpose: a separate expiry pass would be a second place that
 * decides whether an agent is present.
 *
 * @param ledger where the runner currently stands
 * @param desired the agent → brain of every agent whose `running` flag is set
 * @param now epoch milliseconds, the caller's clock
 * @returns the new ledger and what the socket must do, in the order to do it
 */
export function reconcile(
  ledger: PresenceLedger,
  desired: ReadonlyMap<string, string>,
  now: number,
): { ledger: PresenceLedger; actions: PresenceAction[]; nextDeadline: number | null } {
  const next = new Map<string, PresenceEntry>();
  const actions: PresenceAction[] = [];

  for (const [agent, entry] of ledger) {
    const wanted = desired.get(agent);
    if (wanted === entry.workspace) {
      // Still working, in the same brain. A linger in flight is cancelled, which
      // is what keeps a stretch of queued units one unbroken session.
      next.set(agent, { workspace: entry.workspace, leaveAt: null });
      continue;
    }
    if (wanted !== undefined) {
      // A different brain. Left at once rather than lingering: the linger exists
      // to bridge a gap in one roster, and sitting in the old brain's roster
      // while working in another would be a claim about the wrong place.
      actions.push({ kind: "leave", agent, workspace: entry.workspace });
      actions.push({ kind: "join", agent, workspace: wanted });
      next.set(agent, { workspace: wanted, leaveAt: null });
      continue;
    }
    if (entry.leaveAt === null) {
      next.set(agent, { workspace: entry.workspace, leaveAt: now + PRESENCE_LINGER_MS });
      continue;
    }
    if (now < entry.leaveAt) {
      next.set(agent, entry);
      continue;
    }
    actions.push({ kind: "leave", agent, workspace: entry.workspace });
  }

  for (const [agent, workspace] of desired) {
    if (next.has(agent)) continue;
    actions.push({ kind: "join", agent, workspace });
    next.set(agent, { workspace, leaveAt: null });
  }

  // When the next linger runs out, so the caller can set one timer rather than
  // poll. Null means nothing is waiting to leave.
  let nextDeadline: number | null = null;
  for (const entry of next.values()) {
    if (entry.leaveAt === null) continue;
    nextDeadline = nextDeadline === null ? entry.leaveAt : Math.min(nextDeadline, entry.leaveAt);
  }

  return { ledger: next, actions, nextDeadline };
}

/** What the runner knows about one agent, reduced to what presence reads. */
export interface RunningAgent {
  /** The flag `run.ts` already keeps to hold one session per agent at a time. */
  running: boolean;
  /** The brain of the unit being run, which is where presence belongs. */
  workspace: string | null;
}

/**
 * Who should be in a roster right now, read off the running flags.
 *
 * **This is the whole of the `start`/`done` rule, as a function.** It is handed
 * the flags rather than told about a transition, so a queue's momentary false
 * between two units cannot be seen as an agent finishing — nothing here is
 * called *because* something happened, it is called *after* something happened
 * and asks what is true now.
 */
export function desiredPresence(work: ReadonlyMap<string, RunningAgent>): Map<string, string> {
  const desired = new Map<string, string>();
  for (const [agent, state] of work) {
    if (!state.running || state.workspace === null) continue;
    desired.set(agent, state.workspace);
  }
  return desired;
}

/** The topics the ledger is currently in, which is what a reconnect must rejoin. */
export function joinedWorkspaces(ledger: PresenceLedger): Map<string, string> {
  return new Map([...ledger].map(([agent, entry]) => [agent, entry.workspace]));
}
