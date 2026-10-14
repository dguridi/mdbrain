// Whether a configured agent's key works here, and if not, why — as a decision.
//
// The server gives every bad key the same refusal, and it should: an anonymous
// caller learns nothing from it. The person who owns the agent can already learn
// the reason through reads they have a right to — the roster, their own roles,
// and the agent's key list — so the reason is assembled here from those, in a
// fixed order, rather than asked of the server a fourth way.
//
// Pure: the probe's answer, the roster and the key list are handed in, so every
// row of the table is a unit test and nothing here can be surprised by a socket.
// `commands/agents.ts` makes the reads and `as` uses the probe alone.

import type { KeyAnswer, KeyRow } from "../auth/api.ts";
import { shownKey } from "../config/secrets.ts";

/** What presenting the key to the MCP server came to. */
export type Probe =
  /** The server took the key. `brains` is null when it took it but its answer could not be read. */
  | { kind: "accepted"; brains: string[] | null }
  | { kind: "refused" }
  /** Nothing was presented: this machine holds no key for the agent. */
  | { kind: "no-key" }
  /** No verdict: the server could not be reached, or answered something that is not one. */
  | { kind: "unchecked"; reason: string };

/**
 * The server's answer read into a probe.
 *
 * **Only a 401 is a refusal.** A 5xx, a timeout or a proxy's page says nothing
 * about the key, and calling any of them *refused* would send a person to renew
 * a key that works — and renewing revokes the old key, which costs every other
 * holder of it as well.
 */
export function readProbe(answer: KeyAnswer): Probe {
  if (answer.status === 401) return { kind: "refused" };
  if (answer.status !== 200) return { kind: "unchecked", reason: `the server answered HTTP ${answer.status}` };
  return { kind: "accepted", brains: brainsOf(answer.whoami) };
}

/** The probe for a request that never got an answer. */
export function unreachedProbe(cause: unknown): Probe {
  const error = cause as Error;
  const reason = error?.name === "TimeoutError" || error?.name === "AbortError" ? "the server did not answer in time" : (error?.message ?? String(cause));
  return { kind: "unchecked", reason };
}

/** The brain names `whoami` lists, or null when its answer is not the shape it documents. */
function brainsOf(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const body: unknown = JSON.parse(text);
    const workspaces = (body as { workspaces?: unknown }).workspaces;
    if (!Array.isArray(workspaces)) return null;
    return workspaces
      .map((w) => (w as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");
  } catch {
    return null;
  }
}

/** One agent as the owner's roster read shows it. */
export interface VisibleAgent {
  id: string;
  org_id: string;
  display_name: string;
  status: string;
}

/** What the person's own session can see: every visible agent, and which organizations they own. */
export interface OwnerView {
  agents: VisibleAgent[];
  ownedOrgIds: ReadonlySet<string>;
}

/** Why the server refused a key, as far as the owner's reads can tell. */
export type RefusalCause =
  | { kind: "signed-out" }
  | { kind: "recreated" }
  | { kind: "deleted" }
  | { kind: "not-owner" }
  | { kind: "disabled" }
  | { kind: "revoked"; at: string }
  | { kind: "unknown-key" }
  | { kind: "unexplained" };

/** The verdict on one agent. */
export type Verdict =
  | { kind: "accepted"; brains: string[] | null }
  | { kind: "no-key" }
  | { kind: "unchecked"; reason: string }
  | { kind: "refused"; cause: RefusalCause };

/** The configured entry the verdict is about. */
export interface CheckedEntry {
  name: string;
  id: string;
  /** Every id this machine configures, this entry's included: a namesake among them is not a carry-over. */
  configuredIds: ReadonlySet<string>;
}

/**
 * Whether explaining a refusal needs the agent's key list.
 *
 * Only the last rows of the table read it, and the read is owner-gated, so it
 * is asked only where the earlier rows have not already answered: the agent is
 * visible, in an organization this account owns, and not disabled.
 */
export function needsKeys(entry: CheckedEntry, owner: OwnerView): boolean {
  const agent = owner.agents.find((a) => a.id === entry.id);
  return agent !== undefined && owner.ownedOrgIds.has(agent.org_id) && agent.status !== "disabled";
}

/**
 * The verdict, from the probe and — for a refusal — what the owner can see.
 *
 * The rows are checked in a fixed order, and the order is the decision: each
 * is the most specific explanation the reads support, and the last is an honest
 * *cannot see why* rather than a guess.
 *
 * **The two key-list rows rest on the prefix**, 8 hex characters that are unique
 * in practice and not by any constraint. A wrong *this is your key* needs two of
 * one agent's keys to share a prefix, about once in four billion mints, and that
 * is accepted rather than designed around.
 *
 * @param owner the roster as the person's session reads it, or null when there
 *   is no session to read it with
 * @param keys the agent's key list, or null when it was not read or could not be
 * @param heldPrefix the prefix of the key this machine presented
 */
export function verdictFor(
  probe: Probe,
  entry: CheckedEntry,
  heldPrefix: string | null,
  owner: OwnerView | null,
  keys: readonly KeyRow[] | null,
): Verdict {
  if (probe.kind === "accepted") return { kind: "accepted", brains: probe.brains };
  if (probe.kind === "no-key") return { kind: "no-key" };
  if (probe.kind === "unchecked") return { kind: "unchecked", reason: probe.reason };
  const refused = (cause: RefusalCause): Verdict => ({ kind: "refused", cause });
  if (owner === null) return refused({ kind: "signed-out" });

  const agent = owner.agents.find((a) => a.id === entry.id);
  if (agent === undefined) {
    // Exactly one managed namesake that this machine does not already configure,
    // which is `configure`'s rule for offering a carry-over: with two there is no
    // telling which replaced it, and one configured here is another entry's agent
    // renamed, not this one's replacement. Saying *recreated* in either case would
    // send the person to a carry-over that is not offered.
    const namesakes = owner.agents.filter((a) => a.display_name === entry.name && owner.ownedOrgIds.has(a.org_id));
    const carried = namesakes.length === 1 && !entry.configuredIds.has(namesakes[0].id);
    return refused({ kind: carried ? "recreated" : "deleted" });
  }
  if (!owner.ownedOrgIds.has(agent.org_id)) return refused({ kind: "not-owner" });
  if (agent.status === "disabled") return refused({ kind: "disabled" });
  if (keys !== null && heldPrefix !== null) {
    const row = keys.find((k) => k.key_prefix === heldPrefix);
    if (row?.revoked_at) return refused({ kind: "revoked", at: row.revoked_at });
    if (row === undefined) return refused({ kind: "unknown-key" });
  }
  return refused({ kind: "unexplained" });
}

/** Whether a verdict counts as working, which is what `agents check`'s exit code reports. */
export function isAccepted(verdict: Verdict): boolean {
  return verdict.kind === "accepted";
}

/**
 * The verdict as one sentence, with the command that ends it where there is one.
 *
 * Every remedy names a command or a page, because a verdict a person cannot act
 * on is a diagnosis and not an answer.
 */
export function verdictSentence(name: string, verdict: Verdict, heldPrefix: string | null = null): string {
  switch (verdict.kind) {
    case "accepted":
      if (verdict.brains === null) return "accepted";
      return verdict.brains.length === 0
        ? "accepted, but no brain shares it: it will find no work"
        : `accepted, in ${verdict.brains.join(", ")}`;
    case "no-key":
      return `no key on this machine: run mdbrain agents renew ${name}`;
    case "unchecked":
      return `could not check: ${verdict.reason}`;
    case "refused":
      return `refused: ${causeSentence(name, verdict.cause, heldPrefix)}`;
  }
}

function causeSentence(name: string, cause: RefusalCause, heldPrefix: string | null): string {
  switch (cause.kind) {
    case "signed-out":
      return "sign in with mdbrain login to learn why";
    case "recreated":
      return "agent recreated under the same name: run mdbrain configure to carry this configuration over";
    case "deleted":
      return `agent deleted in markdown-den: mdbrain agents remove ${name}`;
    case "not-owner":
      return "you no longer own this agent's organization";
    case "disabled":
      return "agent disabled in markdown-den: enable it on the agent's page";
    case "revoked":
      return `key revoked on ${cause.at.slice(0, 10)}: mdbrain agents renew ${name}`;
    case "unknown-key":
      return `${heldPrefix === null ? "this key" : shownKey(heldPrefix)} is not one markdown-den knows for this agent (minted against another server?): mdbrain agents renew ${name}`;
    case "unexplained":
      return "refused for a reason the runner cannot see";
  }
}

/**
 * The verdict in a few words, for a row in the browser's list: a mark that
 * carries the state and words that still carry it without the colour.
 */
export function verdictBadge(verdict: Verdict | null): string {
  if (verdict === null) return "… checking";
  switch (verdict.kind) {
    case "accepted":
      return "✓ accepted";
    case "no-key":
      return "✗ no key";
    case "unchecked":
      return "? could not check";
    case "refused":
      return `✗ refused: ${BADGE_CAUSE[verdict.cause.kind]}`;
  }
}

const BADGE_CAUSE: Record<RefusalCause["kind"], string> = {
  "signed-out": "sign in to see why",
  recreated: "agent recreated",
  deleted: "agent deleted",
  "not-owner": "not your organization",
  disabled: "agent disabled",
  revoked: "key revoked",
  "unknown-key": "unknown key",
  unexplained: "reason unknown",
};
