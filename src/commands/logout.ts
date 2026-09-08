// `mdbrain logout` — end the session, rather than forget it.
//
// Logging out is a deliberate act, so it should mean the session is actually
// gone: deleting the file alone leaves a live refresh token that a copy of that
// file could still use. The revocation is `scope=local`, which ends this session
// and no other — a signed-in browser is a different session and stays signed in.
//
// **The file is removed whatever the server said.** Offline, or a server that
// refuses, must not leave the person still logged in locally with no way to say
// otherwise; the fallback is the weaker outcome, said out loud rather than
// hidden.

import type { CommandSpec } from "../cli.ts";
import { signOutLocal } from "../auth/api.ts";
import { clearSession, loadSession } from "../auth/store.ts";
import { readySession } from "./session.ts";

export const logout: CommandSpec = {
  name: "logout",
  summary: "end this session — revoked, not merely forgotten",
  async run({ out, err }) {
    const loaded = await loadSession();
    if (loaded.kind === "none") {
      out("You are not signed in.");
      return 0;
    }

    let revoked = false;
    let alreadyOver = false;
    let reason = "";
    if (loaded.kind === "session") {
      // **The stored access token is the wrong one to revoke with.** It lives an
      // hour and the session lives days, so the ordinary logout — signed in
      // yesterday, out today — would present an expired JWT, be refused, and
      // then delete the only local copy of a refresh token that is still live on
      // the server. Refreshing first is what makes the revocation reach the
      // thing that actually has to end, and it is the same path every other
      // command takes before acting.
      const ready = await readySession();
      if (ready.kind === "ready") {
        try {
          await signOutLocal(ready.accessToken);
          revoked = true;
        } catch (cause) {
          reason = (cause as Error).message;
        }
      } else if (ready.reason === "refreshed-away") {
        // The server refused the refresh, which is the server saying this
        // session is already over. There is nothing left to revoke and the
        // outcome asked for has been reached by another route.
        alreadyOver = true;
      } else {
        // `readySession`'s own sentence ends by suggesting a retry when the
        // connection is back. That is right where it is written and wrong here:
        // the file is about to be deleted, so there is nothing left to retry
        // with, and the only remedy is the app's own sign-out below.
        reason = "the server could not be reached";
      }
    } else {
      reason = "the stored session could not be read, so there was no token to revoke";
    }

    await clearSession();

    if (revoked) {
      out("Signed out. The session is revoked and the file is gone.");
    } else if (alreadyOver) {
      out("Signed out. The server had already ended this session, and the file is gone.");
    } else {
      out("Signed out locally — the session file is gone.");
      err(`The server was not told, so the session may still be live until it expires: ${reason}`);
      err("Use *Sign Out Everywhere* in the app if that matters — the app's ordinary sign-out ends that browser only.");
    }
    return 0;
  },
};
