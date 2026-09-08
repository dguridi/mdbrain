// What a stored session is, and the one decision every command makes about it
// before doing anything else.
//
// A CLI is not a long-running browser tab, so there is no background refresh
// timer here and there must not be one: each command starts, reads the file,
// refreshes if it must, does its work and exits. The decision is pure so the
// three outcomes — carry on, refresh first, this session is over — can be tested
// without a clock, a network or a stack.

/** The session as it rests on disk, and nothing more. */
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, in seconds since the epoch, as Supabase reports it. */
  expiresAt: number;
}

/** What a command should do about the session it found. */
export type SessionAction =
  | { kind: "use" }
  | { kind: "refresh" }
  | { kind: "sign-in"; reason: SignInReason };

/** Why a command cannot proceed without a person. */
export type SignInReason = "no-session" | "unreadable" | "no-refresh-token";

/**
 * How close to expiry counts as expired.
 *
 * A token that is valid for another two seconds is not usable: the request it
 * would authorize has to be built, sent and answered, and a clock a little
 * behind the server's turns "nearly expired" into a refusal in the middle of the
 * work rather than before it. Sixty seconds is the ordinary margin, and the cost
 * of being wrong in this direction is one silent refresh.
 */
export const REFRESH_MARGIN_SECONDS = 60;

/**
 * Decide what to do with the session on disk.
 *
 * `null` means the file was absent or could not be read as a session — the two
 * are told apart by the caller, since only it knows which happened, and they
 * read differently to a person.
 *
 * @param session the stored session, or null when there is none to use
 * @param nowSeconds the current time in seconds since the epoch
 */
export function sessionAction(
  session: StoredSession | null,
  nowSeconds: number,
  margin = REFRESH_MARGIN_SECONDS,
): SessionAction {
  if (!session) return { kind: "sign-in", reason: "no-session" };
  // A session with no refresh token cannot be renewed, so an expired one is over
  // rather than refreshable — and a still-valid one is usable exactly once more.
  if (!session.refreshToken) {
    return session.expiresAt - margin > nowSeconds
      ? { kind: "use" }
      : { kind: "sign-in", reason: "no-refresh-token" };
  }
  return session.expiresAt - margin > nowSeconds ? { kind: "use" } : { kind: "refresh" };
}

/**
 * Read a session out of whatever the file held.
 *
 * Deliberately strict about the three fields it needs and silent about anything
 * else the file carries: a session written by a later version with more in it is
 * still a session, while one missing a token is not, however well-formed.
 *
 * @returns the session, or null when the text is not one
 */
export function parseSession(text: string): StoredSession | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const accessToken = record.accessToken;
  const refreshToken = record.refreshToken;
  const expiresAt = record.expiresAt;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  if (typeof refreshToken !== "string") return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  return { accessToken, refreshToken, expiresAt };
}

/** What the person is told when a command cannot proceed without them. */
export function signInMessage(reason: SignInReason): string {
  switch (reason) {
    case "no-session":
      return "You are not signed in. Run `mdbrain login`.";
    case "unreadable":
      return "The stored session could not be read. Run `mdbrain login`.";
    case "no-refresh-token":
      return "Your session has expired. Run `mdbrain login`.";
  }
}

/**
 * What a refused refresh means, said once and without a retry.
 *
 * Separate from {@link signInMessage} because it answers a different question:
 * the session was real and the server ended it — *sign out other devices* in the
 * app, or a genuine expiry — and reporting that as a network problem, or
 * retrying it, is the failure this exists to prevent.
 */
export const REFRESH_REFUSED_MESSAGE =
  "Your session has ended — it may have been signed out from the app. Run `mdbrain login`.";

/**
 * What a refresh that never reached an answer means, which is the opposite
 * thing.
 *
 * Being offline, a proxy in the way or a server that fell over are all *not* a
 * revocation, and telling somebody their session has ended is worse than
 * useless there: they run `mdbrain login`, which needs the same network and
 * fails too, and the good session they still had has been thrown away for
 * nothing. The distinction is whether the server answered at all.
 *
 * @param detail what went wrong, as the failure described itself
 */
export function refreshUnreachableMessage(detail: string): string {
  return `Could not reach markdown-den to refresh your session: ${detail}. The session has not ended — try again when the connection is back.`;
}

/**
 * What a refusal that arrives mid-command means, when the session on disk had
 * not expired.
 *
 * **An access token outlives the session it belongs to.** Signing out revokes the
 * session and its refresh token, but the access token already on disk stays
 * signature-valid until its hour is up — so {@link sessionAction} says *use it*,
 * the command proceeds, and the refusal arrives mid-flight instead of before the
 * work. Reporting that as "could not read the roster" describes the wrong thing:
 * the roster is fine, and the person needs to know they are signed out.
 *
 * **The status to key on is 403, and getting that wrong made the first version of
 * this unreachable.** It tested for 401 on the reasoning that a 403 is the server
 * saying something about the *request* — which is true of most endpoints and false
 * of this one. `GET /auth/v1/user` answers **403** for a revoked session, for a
 * malformed token and for a bad signature alike, and answers 401 only when there
 * is no `Authorization` header at all — which the caller can never produce,
 * because it always sends the token it holds. So the 401 branch could not fire
 * from a real command, and the sentence it guarded never appeared in the one
 * situation it was written for.
 *
 * **401 is kept anyway**, costing nothing: if a caller ever does reach this
 * without a bearer, *sign in again* is still the right thing to say.
 *
 * **The wording covers the class rather than one member of it.** A 403 here is a
 * revoked session, a damaged session file or a token for another project, and
 * those are not distinguishable by status. They have the same remedy, so the
 * sentence names the likely cause without asserting it, and the caller appends
 * the server's own words so the actual reason is still on screen. Keying on
 * GoTrue's message text would separate them, and is deliberately not done: it
 * was measured against a local stack and production runs a hosted build, so it
 * would be a guess dressed as precision.
 *
 * @param status the HTTP status the request was refused with
 * @returns the sentence to print, or null when this is not that failure
 */
export function signInAgainMessage(status: number): string | null {
  return status === 403 || status === 401 ? SESSION_NOT_ACCEPTED_MESSAGE : null;
}

/**
 * What a mid-command refusal is told to the person.
 *
 * A sibling of {@link REFRESH_REFUSED_MESSAGE} rather than the same sentence: a
 * refused *refresh* really is the session ending, while a refused *request* is
 * the credentials not being accepted, which has one more cause. Saying "your
 * session has ended" over a damaged session file would be confidently wrong about
 * something the person can see is not true.
 */
export const SESSION_NOT_ACCEPTED_MESSAGE =
  "Your session is no longer accepted — it may have been signed out from the app, or the stored session may be damaged. Run `mdbrain login`.";
