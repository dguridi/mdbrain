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
  refreshAhead,
  refreshUnreachableMessage,
  sessionAction,
  signInMessage,
  type StoredSession,
} from "../auth/session.ts";
import { loadSession, saveSession, withSessionLock, type LoadedSession } from "../auth/store.ts";

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
 *
 * **The refresh happens under the session lock, and the file is read again once
 * the lock is held.** Another `mdbrain` may have refreshed while this one waited,
 * and the token this one read first has then been rotated away; re-reading finds
 * the pair it left, which usually needs no refresh at all.
 *
 * @param aheadSeconds refresh a still-usable token once it has less than this
 *   left, for a caller that holds the token rather than spending it at once. A
 *   refresh asked for early that gets no verdict — no answer, or a server error
 *   or rate limit — is not a reason to stop: the token in hand still works, so it
 *   is what comes back, and a later step asks again.
 */
export async function readySession(aheadSeconds?: number): Promise<SessionOutcome> {
  const loaded = await loadSession();
  const first = judge(loaded, aheadSeconds);
  // A file that did not parse may be one a refresh is writing this moment, since
  // this first read takes no lock; it is read again under the lock, once that
  // writer has finished, before it is called unreadable.
  if (first.outcome && loaded.kind !== "unreadable") return first.outcome;
  return withSessionLock(async () => {
    const again = judge(await loadSession(), aheadSeconds);
    return again.outcome ?? refreshHeld(again.session!, again.early);
  });
}

/**
 * What a session read off disk calls for: an outcome at once (sign in, or use
 * the token as it is), or a refresh, early or due.
 */
function judge(loaded: LoadedSession, aheadSeconds: number | undefined): { outcome: SessionOutcome | null; session: StoredSession | null; early: boolean } {
  const session = loaded.kind === "session" ? loaded.session : null;
  const now = nowSeconds();
  const early = session !== null && aheadSeconds !== undefined && refreshAhead(session, now, aheadSeconds);
  const action = early ? ({ kind: "refresh" } as const) : sessionAction(session, now);

  if (action.kind === "sign-in") {
    // "There is a file and it is not a session" is its own sentence, and the
    // pure decision cannot tell it from absence — only the read can.
    return {
      outcome: { kind: "stop", reason: "sign-in", message: signInMessage(loaded.kind === "unreadable" ? "unreadable" : action.reason) },
      session,
      early,
    };
  }
  if (action.kind === "use") return { outcome: { kind: "ready", accessToken: session!.accessToken }, session, early };
  return { outcome: null, session, early };
}

/** Refreshes a session and writes the new pair back; called with the lock held. */
async function refreshHeld(session: StoredSession, early: boolean): Promise<SessionOutcome> {
  let refreshed: StoredSession;
  try {
    refreshed = await refreshSession(session.refreshToken, nowSeconds());
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
    // Early, a server error or a rate limit is not a verdict either: the
    // refresh was asked for twenty minutes before it was needed, and ending a run
    // over a 503 with a working token in hand would turn a blip into a stop.
    const transient = cause instanceof AuthError && (cause.status >= 500 || cause.status === 429);
    if (early && (!refused || transient)) return { kind: "ready", accessToken: session.accessToken };
    return refused
      ? { kind: "stop", reason: "refreshed-away", message: REFRESH_REFUSED_MESSAGE }
      : {
          kind: "stop",
          reason: "unreachable",
          message: refreshUnreachableMessage((cause as Error).message),
        };
  }
  // Outside the fallback above, early or not: the server has rotated the refresh
  // token away by now, so a pair that could not be written is a session the next
  // command cannot renew, and handing back the old token would hide that.
  try {
    await saveSession(refreshed);
  } catch (cause) {
    return { kind: "stop", reason: "unreachable", message: refreshUnreachableMessage((cause as Error).message) };
  }
  return { kind: "ready", accessToken: refreshed.accessToken };
}
