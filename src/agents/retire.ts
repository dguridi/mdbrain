// Revoking the key a machine is giving up, by its prefix, in markdownbrain.ai.
//
// Two commands give a key up — removing an agent's configuration and renewing
// its key — and both revoke the one they let go of, because a key nobody holds
// any more is a key nobody will ever think to revoke. They share this so the two
// cannot come to disagree about when a revoke is skipped or what a failed one
// says.
//
// **Best-effort, and always after the local change it follows.** The person
// asked for the removal or the renewal; the revoke is the tidy-up. So a revoke
// that cannot be done — signed out, offline, no longer the owner — never undoes
// or blocks what was asked, and is reported with the sentence that tells the
// person where to finish it by hand.
//
// It revokes **by prefix**, through the two owner RPCs that already exist, so it
// needs no server change. That is safe because each machine mints its own key:
// the keychain does not travel with `config.json`, so the prefix a machine is
// giving up is one only that machine holds.

import type { KeyRow } from "../auth/api.ts";
import { shownKey } from "../config/secrets.ts";
import { redactSecrets } from "../run/diagnosis.ts";

/** What became of the key that was given up. */
export type Retirement =
  | { kind: "revoked"; prefix: string }
  /** Nothing to revoke: no key was held, it is already revoked, or the server does not know it. */
  | { kind: "nothing"; prefix: string | null; why: string }
  /** It should have been revoked and could not be, so it is still live. */
  | { kind: "live"; prefix: string; problem: string };

/** The two owner calls a retirement makes, handed in so a test can stand them in. */
export interface RetireCalls {
  listKeys: (accessToken: string, agentId: string) => Promise<KeyRow[]>;
  revoke: (accessToken: string, keyId: string) => Promise<void>;
}

/**
 * Revoke the key with this prefix, if markdownbrain.ai has it live.
 *
 * @param accessToken the person's session, or null when there is none — which
 *   leaves the key live and says so, rather than skipping in silence
 */
export async function retireKey(
  calls: RetireCalls,
  accessToken: string | null,
  agentId: string,
  prefix: string | null,
): Promise<Retirement> {
  if (prefix === null) return { kind: "nothing", prefix, why: "no key was held here" };
  if (accessToken === null) return { kind: "live", prefix, problem: "you are signed out" };
  try {
    const rows = await calls.listKeys(accessToken, agentId);
    // Prefixes are unique in practice and not by constraint; a collision within
    // one agent's keys is about one in four billion mints, and accepted.
    const row = rows.find((k) => k.key_prefix === prefix);
    if (row === undefined) return { kind: "nothing", prefix, why: "markdownbrain.ai does not know it for this agent" };
    if (row.revoked_at) return { kind: "nothing", prefix, why: "it was already revoked" };
    await calls.revoke(accessToken, row.id);
    return { kind: "revoked", prefix };
  } catch (cause) {
    // Redacted here, once, because every command that can leave a key live
    // prints this text, and it is the body of whatever answered the person's
    // request: a proxy that echoes the request echoes their bearer with it.
    return { kind: "live", prefix, problem: redactSecrets((cause as Error).message) };
  }
}

/** The sentence for a key that is still live, shared by every command that can leave one. */
export function stillLiveSentence(prefix: string): string {
  return `the key ${shownKey(prefix)} is still live in markdownbrain.ai; revoke it on the agent's page`;
}

/** What a retirement says, as a clause about the key that was given up. */
export function retirementSentence(retirement: Retirement): string {
  switch (retirement.kind) {
    case "revoked":
      return `the key ${shownKey(retirement.prefix)} was revoked in markdownbrain.ai`;
    case "nothing":
      return retirement.prefix === null ? "there was no key to revoke" : `nothing to revoke for ${shownKey(retirement.prefix)}: ${retirement.why}`;
    case "live":
      return `${stillLiveSentence(retirement.prefix)} (${retirement.problem.replace(/\.$/, "")})`;
  }
}
