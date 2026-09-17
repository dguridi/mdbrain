// What `whoami` prints, decided without a network.
//
// The read is three flat lists — the organizations the account can see, the
// agents in them, and the roles the account holds in each — and what a person
// wants is the agents they could actually run, grouped under the organization
// each belongs to. That join is arithmetic rather than I/O, so it lives here
// where it can be tested, including the three cases that are easy to get wrong:
// an organization with no agents at all, an agent whose organization is in
// neither list, and an agent this account can read but may not manage.
//
// **Readable and runnable are not the same set**, and this is the file that
// keeps them apart. An ordinary member of an organization may read every agent
// in it and run none of them, so listing what the read returned would name
// agents that cannot be configured, cannot be given a key, and cannot be
// started — which is worse than not naming them, because the list is what a
// person checks when one of those fails.

import type { Agent, Membership, Organization } from "../auth/api.ts";
import { NOTHING_TO_MANAGE, compareNames, ownedOrganizations } from "../configure/questions.ts";

/** One organization and the agents listed under it. */
export interface RosterGroup {
  organization: string;
  agents: string[];
}

/**
 * The roster as `whoami` prints it: the agents this account may run, grouped.
 *
 * The counts are carried rather than recomputed by the renderer because they
 * answer questions the groups cannot: an empty list means one thing to an
 * account in no organization and another to one that is in several and owns
 * none, and those are different sentences with different remedies.
 *
 * **Agents read but not listed are not among them, and their absence here is
 * the point.** They belong to somebody else, this command is not asked about
 * them, and a count carried on the roster is one line away from being printed.
 */
export interface Roster {
  /** One per organization whose agents this account may manage, plus at most one for rows whose organization it cannot read. */
  groups: RosterGroup[];
  /** Organizations this account can read at all, owned or not. */
  visible: number;
  /** How many of those it may manage agents in. */
  manageable: number;
}

/** The heading rows whose organization was in neither list are gathered under. */
const UNREADABLE_ORGANIZATION = "(an organization this account cannot read)";

/**
 * Group the agents this account may run under the organizations they belong to.
 *
 * **Only organizations this account owns are given a heading**, decided by
 * `ownedOrganizations` — literally the same function `configure` filters its
 * picker with, so the two lists cannot drift apart into a `whoami` that names an
 * agent `configure` will not offer.
 *
 * An owned organization with no agents is **kept**, because "you own this
 * organization and it has no agents" is an answer, and dropping it would make an
 * empty roster indistinguishable from not being a member.
 *
 * The two ways an agent goes unlisted are still told apart, and must not be
 * merged. An agent in an organization that was *read* but is not owned is
 * **withheld**: expected, somebody else's, and dropped without a trace. An
 * agent whose `org_id` matches no organization at all is an **orphan**, kept
 * under a heading that says so: it means the two reads disagreed, which is
 * possible since they are two requests, and dropping it alongside the withheld
 * would lose a disagreement in the same silence as a routine omission.
 *
 * **Ordered by `compareNames`, not by the order the rows arrived in**, and for
 * the same reason the picker is: the two lists are supposed to be the same list,
 * and the server's `order=name` is the database's collation rather than this
 * one — so `team-2` and `team-10` come back in an order that contradicts the
 * picker, which is exactly the kind of disagreement a shared filter is here to
 * prevent.
 */
export function groupRoster(organizations: Organization[], agents: Agent[], memberships: Membership[]): Roster {
  const owned = ownedOrganizations(organizations, memberships);
  const byOrg = new Map<string, string[]>();
  for (const org of owned) byOrg.set(org.id, []);
  const readable = new Set(organizations.map((o) => o.id));

  const orphans: string[] = [];
  // Sorted on the display name rather than the label, so a disabled agent keeps
  // its place in the list instead of being ordered by its parenthesis.
  for (const agent of [...agents].sort((a, b) => compareNames(a.display_name, b.display_name))) {
    const label = agent.status === "active" ? agent.display_name : `${agent.display_name} (${agent.status})`;
    const bucket = byOrg.get(agent.org_id);
    // The middle case is the withheld one: an agent whose organization was read
    // and is not owned goes nowhere at all, which is why there is no branch for
    // it to go into.
    if (bucket) bucket.push(label);
    else if (!readable.has(agent.org_id)) orphans.push(label);
  }

  const groups = owned
    .map((org) => ({
      organization: org.name,
      agents: byOrg.get(org.id) ?? [],
    }))
    .sort((a, b) => compareNames(a.organization, b.organization));
  if (orphans.length > 0) groups.push({ organization: UNREADABLE_ORGANIZATION, agents: orphans });
  return { groups, visible: organizations.length, manageable: owned.length };
}

/** The sentence for an account that belongs to no organization at all. */
const NO_ORGANIZATIONS = "No organizations are visible to this account.";

/**
 * Render the roster as the lines `whoami` prints.
 *
 * **It ends on the last group**, and the agents this account may not run are
 * not mentioned on the way there. The question the command answers is which
 * agents this machine may run; how many belong to organizations it does not own
 * answers a different one, and the person reading can do nothing with it.
 */
export function renderRoster(account: string, roster: Roster): string[] {
  const lines = [`Signed in as ${account}.`, ""];
  // Said on the count rather than on an empty list, because an orphan group is
  // still a group: an account that may run nothing and has one unreadable row
  // would otherwise be handed a list of agents and never told it owns none.
  // Two sentences, because the two facts have different remedies — an account
  // in no organization has nothing to be told about ownership, and one that is
  // in several and owns none would be left thinking the read failed.
  if (roster.manageable === 0) {
    lines.push(roster.visible === 0 ? NO_ORGANIZATIONS : NOTHING_TO_MANAGE);
    if (roster.groups.length > 0) lines.push("");
  }
  for (const group of roster.groups) {
    lines.push(group.organization);
    if (group.agents.length === 0) lines.push("  (no agents)");
    else for (const agent of group.agents) lines.push(`  ${agent}`);
  }
  return lines;
}
