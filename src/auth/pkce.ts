// The random string a PKCE login needs, and the transform that derives its
// challenge.
//
// The verifier is what proves the program that asked for the code is the one
// redeeming it. A loopback listener is a server anything on the machine can
// reach, and this is the whole of the defence against a code injected there: a
// code minted for somebody else's challenge cannot be exchanged with this
// verifier, so an injected one buys nothing.
//
// **There is deliberately no `state` here, and its absence is a finding rather
// than an omission.** GoTrue's authorize endpoint takes no client `state` and
// echoes none back — `_getUrlForProvider` in the installed `@supabase/auth-js`
// builds the URL from `provider`, `redirect_to`, `scopes` and the PKCE pair, and
// the `queryParams` escape hatch is forwarded to the upstream provider rather
// than to the redirect. So a `state` sent from here would never arrive at the
// listener, and a listener requiring one would refuse every real callback.
//
// Kept apart from the listener and the browser so the encoding — which is where
// this goes wrong quietly — can be read and tested on its own.

import { createHash, randomBytes } from "node:crypto";

/**
 * Base64url, which is base64 with two characters swapped and the padding gone.
 *
 * Not decoration either: a `+` or a `/` in a query parameter is a different
 * string by the time a server reads it, and `=` is padding an authorization
 * endpoint has no use for. Doing it here rather than at each call site is what
 * stops one of the two values being encoded differently from the other.
 */
export function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A fresh code verifier: 32 random bytes, base64url'd.
 *
 * RFC 7636 allows 43 to 128 characters; 32 bytes lands on 43, which is the
 * minimum and is 256 bits of entropy. Longer buys nothing an attacker would
 * notice.
 */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

/**
 * The challenge derived from a verifier — the S256 method, never `plain`.
 *
 * `plain` sends the verifier itself to the authorization endpoint, which gives
 * anything that can read the request the one secret the exchange rests on.
 */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
