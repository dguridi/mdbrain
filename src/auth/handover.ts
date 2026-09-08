// Reading what the app's authorise page posts to the listener.
//
// The browser sends a form submission rather than a `fetch`, because a public
// page reaching a loopback address runs into mixed-content rules, CORS and
// Chrome's private-network preflight, while a top-level form POST is none of
// those. So what arrives here is `application/x-www-form-urlencoded`, and the
// tokens are in the body — never in a URL, where they would reach browser
// history, shell history and every log in between.
//
// **There is no `state`, no code to exchange, and no origin rule**, so the
// challenge is the whole of what ties a payload to the login that is waiting: it
// was in the address the CLI opened, and a page that was not sent there does not
// have it. Because it is the only guard, it is compared as a secret — in full,
// in constant time — rather than as a string. Pure, so the checking can be read
// and tested without a socket.

import { timingSafeEqual } from "node:crypto";

/** What the listener does with something posted to it. */
export type HandoverReading =
  | { kind: "session"; accessToken: string; refreshToken: string; expiresAt: number }
  | { kind: "refused"; reason: HandoverRefusal };

/**
 * Why a request is not the session this login is waiting for.
 *
 * The first three are decided here, from the payload. The last two are the
 * listener's to raise — it is the half that knows what was asked for and what
 * has already happened — and they live in this union so that every refusal a
 * person can be shown has its wording in one place.
 */
export type HandoverRefusal =
  | "wrong-challenge"
  | "incomplete"
  | "not-a-form"
  | "not-a-callback"
  | "callback-not-posted"
  | "already-handed-over";

/** The parts of the request this decision needs. */
export interface PostedHandover {
  contentType: string | null;
  body: string;
}

/**
 * Compare an offered challenge with this login's, as a secret rather than a
 * string.
 *
 * Constant-time and full-length: a prefix is not a match, and the time taken
 * says nothing about how much of the value was right. Lengths are checked first
 * because `timingSafeEqual` throws on unequal buffers; that leaks the length,
 * which is a fixed, public property of every challenge this program derives.
 */
function challengeMatches(offered: string | null, expected: string): boolean {
  if (offered === null) return false;
  const a = Buffer.from(offered, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read a posted payload into a session, or into why it was not one.
 *
 * @param posted the request's content type and raw body
 * @param expectedChallenge this login's challenge, derived from its own verifier
 */
export function readHandover(posted: PostedHandover, expectedChallenge: string): HandoverReading {
  if (!posted.contentType?.includes("application/x-www-form-urlencoded")) {
    return { kind: "refused", reason: "not-a-form" };
  }

  const fields = new URLSearchParams(posted.body);
  // Checked before anything is read out of the body, so a payload for a
  // different login cannot have its contents inspected, let alone used.
  if (!challengeMatches(fields.get("challenge"), expectedChallenge)) {
    return { kind: "refused", reason: "wrong-challenge" };
  }

  const accessToken = fields.get("access_token");
  const refreshToken = fields.get("refresh_token");
  const expiresAt = Number(fields.get("expires_at"));
  if (!accessToken || !refreshToken || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { kind: "refused", reason: "incomplete" };
  }
  return { kind: "session", accessToken, refreshToken, expiresAt };
}

/**
 * What the person waiting is told about a refusal.
 *
 * Every refusal is reported, including the ones decided before the body is read.
 * A request that is silently answered is a request nobody can notice.
 *
 * **The wording carries the weight, because the volumes are nothing alike.** A
 * browser pointed at a web server asks it for more than the one page: a favicon
 * at minimum, and whatever else it decides it wants. That arrives on every
 * successful login, so a line phrased as an alarm is an alarm that fires every
 * time nothing is wrong, and the next one — the one that matters — is read the
 * same way and skipped. So the everyday case says what it is, plainly, and the
 * `GET /callback?access_token=…` that tries to put tokens in a URL gets its own
 * sentence and keeps the alarm to itself.
 */
export function handoverRefusalMessage(reason: HandoverRefusal): string {
  switch (reason) {
    case "wrong-challenge":
      return "Something posted a sign-in that did not belong to this command; it was ignored.";
    case "incomplete":
      return "A sign-in arrived without the tokens it needed; it was ignored.";
    case "not-a-form":
      return "Something posted to this listener that was not a sign-in; it was ignored.";
    case "not-a-callback":
      return "The browser asked this listener for something other than the sign-in, as browsers do; it was ignored.";
    case "callback-not-posted":
      return "Something reached this listener's callback without posting a sign-in; it was ignored.";
    case "already-handed-over":
      return "A second sign-in arrived after this one was already complete; it was ignored.";
  }
}

/** Where a request goes: the handover itself, or a refusal with its reason. */
export type HandoverRouting = { kind: "handover" } | { kind: "refuse"; reason: HandoverRefusal };

/**
 * What the listener should do with an incoming request, decided from its line alone.
 *
 * Split out from the listener because the two refusals it can raise are not the
 * same event and used to share one sentence. **The address decides which**: a
 * request that never named the callback is the browser being a browser, while a
 * request that named it and did not post is the shape this whole flow exists to
 * rule out. Nothing is dropped either way — both are refused, answered and
 * reported, and only a posted callback reaches the body.
 */
export function routeHandoverRequest(req: { method: string | null; url: string | null }): HandoverRouting {
  if (!(req.url ?? "").startsWith("/callback")) return { kind: "refuse", reason: "not-a-callback" };
  if (req.method !== "POST") return { kind: "refuse", reason: "callback-not-posted" };
  return { kind: "handover" };
}
