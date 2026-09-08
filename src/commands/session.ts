// The one thing every command that needs a session does first.
//
// Read the file, ask the pure decision what to do about it, and either hand back
// a usable access token or the sentence the person needs. Gathered here rather
// than repeated in each command, because the failure that matters — a refused
// refresh, which means the session is over and must not be retried — has to read
// the same way whichever command met it.

import { AuthError, refreshSession } from "../auth/api.ts";
import {
  REFRESH_REFUSED_MESSAGE,
  refreshUnreachableMessage,
  sessionAction,
  signInMessage,
} from "../auth/session.ts";
import { loadSession, saveSession } from "../auth/store.ts";

/**
 * Why a command has no session to work with.
 *
 * `refreshed-away` is the only one that means the session is *gone*; the other
 * two leave whatever was on disk still potentially good, which is what a caller
 * deciding whether to delete it needs to know.
 */
export type StopReason = "sign-in" | "refreshed-away" | "unreachable";

/** Either a session to work with, or what to tell the person instead. */
export type SessionOutcome =
  | { kind: "ready"; accessToken: string }
  | { kind: "stop"; reason: StopReason; message: string };

/** Seconds since the epoch, which is the unit the stored expiry is in. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Produce a usable access token, refreshing first if the stored one has run out.
 *
 * A refreshed pair is written back before it is used: the old refresh token is
 * rotated away by the server as it answers, so a command that used the new
 * session without storing it would leave the next one starting from a token that
 * no longer works.
 */
export async function readySession(): Promise<SessionOutcome> {
  const loaded = await loadSession();
  const session = loaded.kind === "session" ? loaded.session : null;
  const action = sessionAction(session, nowSeconds());

  if (action.kind === "sign-in") {
    // "There is a file and it is not a session" is its own sentence, and the
    // pure decision cannot tell it from absence — only the read can.
    return {
      kind: "stop",
      reason: "sign-in",
      message: signInMessage(loaded.kind === "unreadable" ? "unreadable" : action.reason),
    };
  }
  if (action.kind === "use") return { kind: "ready", accessToken: session!.accessToken };

  try {
    const refreshed = await refreshSession(session!.refreshToken, nowSeconds());
    await saveSession(refreshed);
    return { kind: "ready", accessToken: refreshed.accessToken };
  } catch (cause) {
    // Deliberately one sentence and no retry. The server ending a session is not
    // a transient condition, and asking again cannot change it.
    //
    // **But only a server that answered can have ended it.** An `AuthError`
    // carrying a status is the server refusing; anything else — a thrown fetch,
    // or an answer that was not a session — never got a verdict, and reporting
    // that as a revocation sends somebody to sign in again over the same broken
    // connection and throws away a session that was fine.
    const refused = cause instanceof AuthError && cause.status > 0;
    return refused
      ? { kind: "stop", reason: "refreshed-away", message: REFRESH_REFUSED_MESSAGE }
      : {
          kind: "stop",
          reason: "unreachable",
          message: refreshUnreachableMessage((cause as Error).message),
        };
  }
}
