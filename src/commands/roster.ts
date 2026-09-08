// What `whoami` prints, decided without a network.
//
// The read is two flat lists — the organizations the account can see and the
// agents in them — and what a person wants is one grouped under the other. That
// join is arithmetic rather than I/O, so it lives here where it can be tested,
// including the two cases that are easy to get wrong: an organization with no
// agents at all, and an agent whose organization is not in the list.

import type { Agent, Organization } from "../auth/api.ts";

/** One organization and the agents read for it. */
export interface RosterGroup {
  organization: string;
  agents: string[];
}

/**
 * Group agents under the organizations they belong to.
 *
 * An organization with no agents is **kept**, because "you are in this
 * organization and it has no agents" is an answer, and dropping it would make an
 * empty roster indistinguishable from not being a member.
 *
 * An agent whose `org_id` matches no organization is kept too, under a heading
 * that says so: it means the two reads disagreed — possible, since they are two
 * requests — and silently dropping rows would hide that.
 */
export function groupRoster(organizations: Organization[], agents: Agent[]): RosterGroup[] {
  const byOrg = new Map<string, string[]>();
  for (const org of organizations) byOrg.set(org.id, []);

  const orphans: string[] = [];
  for (const agent of agents) {
    const label = agent.status === "active" ? agent.display_name : `${agent.display_name} (${agent.status})`;
    const bucket = byOrg.get(agent.org_id);
    if (bucket) bucket.push(label);
    else orphans.push(label);
  }

  const groups = organizations.map((org) => ({
    organization: org.name,
    agents: byOrg.get(org.id) ?? [],
  }));
  if (orphans.length > 0) {
    groups.push({ organization: "(an organization this account cannot read)", agents: orphans });
  }
  return groups;
}

/** Render the grouped roster as the lines `whoami` prints. */
export function renderRoster(account: string, groups: RosterGroup[]): string[] {
  const lines = [`Signed in as ${account}.`, ""];
  if (groups.length === 0) {
    lines.push("No organizations are visible to this account.");
    return lines;
  }
  for (const group of groups) {
    lines.push(group.organization);
    if (group.agents.length === 0) lines.push("  (no agents)");
    else for (const agent of group.agents) lines.push(`  ${agent}`);
  }
  return lines;
}
