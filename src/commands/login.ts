// `mdbrain login` — the browser round-trip, once.
//
// The browser is sent to **markdown-den's own sign-in page**, not to an identity
// provider. That is what makes this work for every account: the app's form signs
// somebody in with Google or with an email and a password, and an account with
// no provider has nowhere else it could go. It also means the project's redirect
// allowlist is not involved at all — nothing redirects to the loopback, the app
// posts to it.

import type { CommandSpec } from "../cli.ts";
import { challengeFor, createVerifier } from "../auth/pkce.ts";
import { AuthError, currentUser } from "../auth/api.ts";
import { LOGIN_COMMAND, signInAgainMessage } from "../auth/session.ts";
import { redactSecrets } from "../run/diagnosis.ts";
import { listenForSession, openBrowser } from "../auth/listen.ts";
import { saveSession } from "../auth/store.ts";
import { sessionPath } from "../config/paths.ts";
import { APP_URL } from "../auth/project.ts";

/**
 * Where the browser is sent.
 *
 * The challenge goes in the address rather than the session: it is what ties the
 * page's answer to the command that opened it, and a page that was not sent here
 * does not have it. The verifier never leaves this process.
 */
function cliLoginUrl(port: number, challenge: string): string {
  const url = new URL("/cli-login", APP_URL);
  url.searchParams.set("port", String(port));
  url.searchParams.set("challenge", challenge);
  return url.toString();
}

export const login: CommandSpec = {
  name: "login",
  summary: "sign in with your browser, once",
  flags: [
    { name: "port", summary: "bind this port instead of a free one", takesValue: true },
    { name: "no-browser", summary: "print the address instead of opening it" },
  ],
  async run({ flags, out, err }) {
    // A chosen port is for a person who needs the address to be the same every
    // time — a firewall rule, or a browser they have to paste it into.
    // **A given `--port` is validated as given; only its absence floats.** The
    // flag arrives as `true` on its own and as an empty string when written
    // `--port=`, and both used to fall through to 0 — handing a random port to
    // the one person who asked for a fixed one, which is the failure the flag
    // exists to prevent. So the two questions are kept apart: was a port asked
    // for, and is what was asked for a port.
    const asked = flags.port;
    if (asked === true || asked === "") {
      err("--port needs a port number, as in `--port 8976`.");
      return 1;
    }
    const port = typeof asked === "string" ? Number(asked) : 0;
    if (typeof asked === "string" && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      err(`--port must be a port number, not "${asked}".`);
      return 1;
    }

    // Generated before anything is opened: the challenge has to be in the URL,
    // and the verifier has to outlive the round trip without ever being sent.
    const verifier = createVerifier();
    const challenge = challengeFor(verifier);

    let loopback;
    try {
      loopback = await listenForSession(challenge, (line) => err(line), port);
    } catch (cause) {
      err(`Could not listen on a loopback port: ${(cause as Error).message}`);
      return 1;
    }

    const url = cliLoginUrl(loopback.port, challenge);

    // The address is printed whether or not it is opened. A machine with no
    // browser to launch — over SSH, in a container — is the case that makes a
    // printed URL the real interface rather than a courtesy.
    const launch = flags["no-browser"] !== true;
    out(launch ? "Opening your browser to sign in." : "Open this address to sign in:");
    if (launch) out("If it does not open, use this address:");
    out("");
    out(`  ${url}`);
    out("");
    out(`Waiting for markdown-den to hand the session to 127.0.0.1:${loopback.port} ...`);
    if (launch) openBrowser(url);

    let session;
    try {
      session = await loopback.session;
    } catch (cause) {
      err((cause as Error).message);
      err("");
      err("The page authorises this command with a button; nothing is handed over until it is pressed.");
      return 1;
    } finally {
      loopback.close();
    }

    try {
      await saveSession(session);
    } catch (cause) {
      err(`The sign-in could not be completed: ${(cause as Error).message}`);
      return 1;
    }

    // Naming the account is the check, not a pleasantry: this hands over
    // whichever account was signed in on that page, and the person is the only
    // one who knows whether it was the one they meant.
    //
    // **Two failures wear the same exception and must not wear the same exit
    // code.** A read that could not be made — DNS, a proxy, the auth server
    // down — says nothing about the session, which is on disk and will refresh
    // on the next command; reporting that as a failed login would be false and
    // would send somebody to repeat a login they have already done. A read the
    // auth server *refused* is the opposite: the server is saying this session
    // is not one, and exiting 0 there tells a script the login worked when the
    // very next command cannot. So the status decides, and only the refusal is
    // fatal.
    //
    // `signInAgainMessage` is the same judgement `whoami` makes, deliberately
    // called rather than re-derived: the statuses that mean *not you* are one
    // fact about the auth server, and a second copy here is a second thing to
    // get wrong when it changes.
    try {
      const user = await currentUser(session.accessToken);
      out(`Signed in as ${user.email ?? user.id ?? "your account"}.`);
    } catch (cause) {
      const refusal = cause instanceof AuthError ? cause : null;
      const refused = refusal ? signInAgainMessage(refusal.status, LOGIN_COMMAND) : null;
      if (refusal && refused) {
        // Redacted for the same reason the other three refusal paths are: the
        // body belongs to whatever answered, and a proxy or gateway that echoes
        // the request echoes the bearer with it. The token in flight here is the
        // one that was minted seconds ago, so it is the longest-lived of the
        // four, not the shortest.
        err(`The session that was handed over is not accepted (the server said: ${redactSecrets(refusal.message)}).`);
        err("");
        err(refused);
        return 1;
      }
      err(`Signed in, but the account could not be named: ${(cause as Error).message}`);
    }
    out(`Session stored at ${sessionPath()}`);
    return 0;
  },
};
