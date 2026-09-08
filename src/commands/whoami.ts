// `mdbrain whoami` — the read that proves the login works.
//
// Deliberately a read and not a write, and deliberately one that RLS decides:
// the rows come back only because the caller is who they say they are, so an
// anonymous request returns nothing and a stale token is refused. That is what
// makes it the smallest thing that cannot pass by accident.

import type { CommandSpec } from "../cli.ts";
import { AuthError, currentUser, listAgents, listOrganizations } from "../auth/api.ts";
import { signInAgainMessage } from "../auth/session.ts";
import { groupRoster, renderRoster } from "./roster.ts";
import { readySession } from "./session.ts";

export const whoami: CommandSpec = {
  name: "whoami",
  summary: "print the signed-in account and the agents it can see",
  async run({ out, err }) {
    // Refuses before any request when there is no session — the point of 96-S7
    // is that a signed-out runner does not contact the database at all.
    const outcome = await readySession();
    if (outcome.kind === "stop") {
      err(outcome.message);
      return 1;
    }

    try {
      const [user, organizations, agents] = await Promise.all([
        currentUser(outcome.accessToken),
        listOrganizations(outcome.accessToken),
        listAgents(outcome.accessToken),
      ]);
      for (const line of renderRoster(user.email ?? user.id ?? "your account", groupRoster(organizations, agents))) {
        out(line);
      }
      return 0;
    } catch (cause) {
      // A session ended from the app is refused here rather than at the refresh,
      // because the access token on disk had not expired yet — so this is the
      // first thing that notices, and it has to say what actually happened.
      //
      // The server's own words are kept rather than replaced, and that matters
      // more than it looks: the status alone cannot separate a revoked session
      // from a damaged session file or a token minted for another project, since
      // `GET /auth/v1/user` answers 403 to all three. The sentence names the
      // likely cause and the remedy they share; GoTrue's own message is what says
      // which of them actually happened.
      const revoked = cause instanceof AuthError ? signInAgainMessage(cause.status) : null;
      const detail = (cause as Error).message;
      err(revoked ? `${revoked} (the server said: ${detail})` : `Could not read the roster: ${detail}`);
      return 1;
    }
  },
};
