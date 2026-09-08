import { describe, it, expect } from "vitest";
import { base64url, challengeFor, createVerifier } from "../src/auth/pkce.ts";
import { handoverRefusalMessage, readHandover, routeHandoverRequest } from "../src/auth/handover.ts";
import { parseSession, sessionAction, signInAgainMessage, REFRESH_MARGIN_SECONDS, SESSION_NOT_ACCEPTED_MESSAGE } from "../src/auth/session.ts";
import { configDir, sessionPath, stateDir } from "../src/config/paths.ts";
import { ANON_KEY, PROJECT_URL, keyRole } from "../src/auth/project.ts";

describe("pkce", () => {
  it("96-S9a: a verifier is base64url and long enough for RFC 7636", () => {
    const verifier = createVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("96-S9b: two logins do not share a verifier", () => {
    expect(createVerifier()).not.toBe(createVerifier());
  });

  // The encoding is the half that fails quietly: a `+` or a `/` in a query
  // parameter is a different string by the time the server reads it.
  it("96-S9c: base64url swaps the two characters and drops the padding", () => {
    expect(base64url(Buffer.from([251, 255, 190]))).toBe("-_--");
    expect(base64url(Buffer.from([0]))).toBe("AA");
  });

  it("96-S9d: the challenge is the S256 of the verifier, not the verifier", () => {
    // The vector from RFC 7636 appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(challengeFor(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(challengeFor(verifier)).not.toBe(verifier);
  });
});

describe("the session the app hands over", () => {
  const CHALLENGE = "a-challenge-derived-from-this-logins-verifier";
  const form = (fields: Record<string, string>) => ({
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams(fields).toString(),
  });
  const good = {
    challenge: CHALLENGE,
    access_token: "at",
    refresh_token: "rt",
    expires_at: "1788000000",
  };

  // 96-S27's shape: what the page posts becomes the session, whatever kind of
  // account signed in — the payload carries no notion of a provider.
  it("96-S27: a well-formed handover becomes a session", () => {
    expect(readHandover(form(good), CHALLENGE)).toEqual({
      kind: "session",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1788000000,
    });
  });

  // 96-S28 — there is no code to exchange in this flow and no state, so the
  // challenge is the only thing tying a payload to the login that is waiting.
  it("96-S28: a payload for another login is refused", () => {
    expect(readHandover(form(good), "a-different-challenge")).toEqual({
      kind: "refused",
      reason: "wrong-challenge",
    });
    expect(readHandover(form({ ...good, challenge: "" }), CHALLENGE)).toEqual({
      kind: "refused",
      reason: "wrong-challenge",
    });
    const { challenge: _absent, ...noChallenge } = good;
    expect(readHandover(form(noChallenge), CHALLENGE)).toEqual({
      kind: "refused",
      reason: "wrong-challenge",
    });
  });

  // 96-S29 — the challenge is the whole guard, so a near miss must be a miss:
  // a truncating comparison would let a prefix of it stand in for the secret.
  it("96-S29: the challenge is matched in full, never by prefix", () => {
    for (const near of [
      CHALLENGE.slice(0, CHALLENGE.length - 1),
      CHALLENGE.slice(1),
      `${CHALLENGE}x`,
      CHALLENGE.toUpperCase(),
    ]) {
      expect(readHandover(form({ ...good, challenge: near }), CHALLENGE)).toEqual({
        kind: "refused",
        reason: "wrong-challenge",
      });
    }
  });

  it("96-S28a: a payload missing a token is refused rather than half-read", () => {
    for (const missing of ["access_token", "refresh_token", "expires_at"]) {
      const fields = { ...good };
      delete (fields as Record<string, string>)[missing];
      expect(readHandover(form(fields), CHALLENGE)).toEqual({
        kind: "refused",
        reason: "incomplete",
      });
    }
    expect(readHandover(form({ ...good, expires_at: "soon" }), CHALLENGE))
      .toEqual({ kind: "refused", reason: "incomplete" });
  });

  it("96-S28b: something that is not a form submission is refused", () => {
    expect(readHandover({ ...form(good), contentType: "application/json" }, CHALLENGE))
      .toEqual({ kind: "refused", reason: "not-a-form" });
  });

  // The challenge is checked before the body is read out, so a payload for a
  // different login never has its tokens looked at.
  it("96-S28c: every refusal has something to say and none of them is a session", () => {
    for (const reason of [
      "wrong-challenge",
      "incomplete",
      "not-a-form",
      "not-a-callback",
      "callback-not-posted",
      "already-handed-over",
    ] as const) {
      expect(handoverRefusalMessage(reason).length).toBeGreaterThan(0);
    }
  });

  it("96-S49: a request that never named the callback is refused as browser noise", () => {
    expect(routeHandoverRequest({ method: "GET", url: "/favicon.ico" })).toEqual({
      kind: "refuse",
      reason: "not-a-callback",
    });
  });

  // The one worth telling somebody about, and the reason the two are separated:
  // it is tokens in a URL, where they reach history, logs and the referrer.
  it("96-S50: a GET at the callback is refused as its own thing, not as noise", () => {
    expect(routeHandoverRequest({ method: "GET", url: "/callback?access_token=x" })).toEqual({
      kind: "refuse",
      reason: "callback-not-posted",
    });
  });

  it("96-S51: only a posted callback reaches the body", () => {
    expect(routeHandoverRequest({ method: "POST", url: "/callback" })).toEqual({ kind: "handover" });
  });

  // A request line can arrive with neither, and the router must not be the thing
  // that throws on it.
  it("96-S52: a request with no method and no url is refused rather than crashing", () => {
    expect(routeHandoverRequest({ method: null, url: null })).toEqual({
      kind: "refuse",
      reason: "not-a-callback",
    });
  });

  it("96-S53: the two refusals do not share a sentence", () => {
    expect(handoverRefusalMessage("not-a-callback")).not.toEqual(
      handoverRefusalMessage("callback-not-posted"),
    );
  });
});

describe("sessionAction", () => {
  const now = 1_000_000;
  const session = { accessToken: "at", refreshToken: "rt", expiresAt: now + 3600 };

  // 96-S3
  it("96-S3: a valid access token is used, with no refresh", () => {
    expect(sessionAction(session, now)).toEqual({ kind: "use" });
  });

  // 96-S4
  it("96-S4: an expired access token asks for a refresh", () => {
    expect(sessionAction({ ...session, expiresAt: now - 1 }, now)).toEqual({ kind: "refresh" });
  });

  // The margin is the point: a token valid for another two seconds cannot carry
  // the request it would authorize.
  it("96-S4a: a token inside the margin is refreshed rather than used", () => {
    expect(sessionAction({ ...session, expiresAt: now + REFRESH_MARGIN_SECONDS - 1 }, now))
      .toEqual({ kind: "refresh" });
    expect(sessionAction({ ...session, expiresAt: now + REFRESH_MARGIN_SECONDS + 1 }, now))
      .toEqual({ kind: "use" });
  });

  // 96-S7 — refusing before any request is what "without contacting the database"
  // means at this layer.
  it("96-S7: no session asks for a sign-in", () => {
    expect(sessionAction(null, now)).toEqual({ kind: "sign-in", reason: "no-session" });
  });

  it("96-S7a: a session with no refresh token is usable until it expires, then over", () => {
    const noRefresh = { ...session, refreshToken: "" };
    expect(sessionAction(noRefresh, now)).toEqual({ kind: "use" });
    expect(sessionAction({ ...noRefresh, expiresAt: now - 1 }, now))
      .toEqual({ kind: "sign-in", reason: "no-refresh-token" });
  });
});

describe("parseSession", () => {
  it("96-S1a: reads the three fields a session is", () => {
    expect(parseSession('{"accessToken":"at","refreshToken":"rt","expiresAt":10}')).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 10,
    });
  });

  it("96-S1b: a session written by a later version keeps being one", () => {
    expect(
      parseSession('{"accessToken":"at","refreshToken":"rt","expiresAt":10,"account":"me"}'),
    ).toMatchObject({ accessToken: "at" });
  });

  it("96-S1c: anything missing a token or an expiry is not a session", () => {
    expect(parseSession("not json")).toBe(null);
    expect(parseSession("null")).toBe(null);
    expect(parseSession('"a string"')).toBe(null);
    expect(parseSession('{"refreshToken":"rt","expiresAt":10}')).toBe(null);
    expect(parseSession('{"accessToken":"","refreshToken":"rt","expiresAt":10}')).toBe(null);
    expect(parseSession('{"accessToken":"at","refreshToken":"rt"}')).toBe(null);
    expect(parseSession('{"accessToken":"at","refreshToken":"rt","expiresAt":"soon"}')).toBe(null);
  });
});

describe("the project the binary talks to", () => {
  // 96-S20 — the paste that matters. A service-role key looks identical at a
  // glance, bypasses RLS entirely, and would ship unrestricted database access
  // inside a binary people install. Nothing else in this suite would notice.
  it("96-S20: ships the anon key and could not ship a service-role one", () => {
    expect(keyRole(ANON_KEY)).toBe("anon");
    expect(keyRole(ANON_KEY)).not.toBe("service_role");
  });

  // 96-S21 — a key and a URL that name different projects is a build that
  // authenticates against one place and reads from another.
  it("96-S21: the key names the project the URL does", () => {
    const ref = JSON.parse(
      Buffer.from(ANON_KEY.split(".")[1], "base64url").toString("utf8"),
    ).ref;
    expect(PROJECT_URL).toBe(`https://${ref}.supabase.co`);
  });

  it("96-S20a: an unreadable key has no role rather than a plausible one", () => {
    expect(keyRole("not-a-jwt")).toBe(null);
    expect(keyRole("")).toBe(null);
    expect(keyRole("a.b.c")).toBe(null);
  });
});

describe("where the session rests", () => {
  const envs = [
    { platform: "win32" as NodeJS.Platform, home: "C:\\Users\\p", env: {} },
    { platform: "darwin" as NodeJS.Platform, home: "/Users/p", env: {} },
    { platform: "linux" as NodeJS.Platform, home: "/home/p", env: {} },
  ];

  // 96-S1 and 96-S11's half that can be tested without running a login: the
  // session lives under the state root rather than the config root, on every
  // platform.
  it("96-S1: the session is under the state root, and never the config root", () => {
    for (const env of envs) {
      expect(sessionPath(env).startsWith(stateDir(env))).toBe(true);
      expect(sessionPath(env).endsWith("session.json")).toBe(true);
      expect(stateDir(env)).not.toBe(configDir(env));
    }
  });

  // Pinned because it is NOT the property the rest of this design leans on, and a
  // reader should meet it here rather than by copying a directory. On Windows and
  // Linux the two roots are disjoint, so copying the config root cannot carry an
  // account; on macOS the state root sits INSIDE the config root, so it can.
  it("96-S1d: on macOS the state root is inside the config root, and elsewhere it is not", () => {
    const [windows, mac, linux] = envs;
    expect(stateDir(mac).startsWith(configDir(mac))).toBe(true);
    expect(stateDir(windows).startsWith(configDir(windows))).toBe(false);
    expect(stateDir(linux).startsWith(configDir(linux))).toBe(false);
  });
});

// These cover the predicate; what a command actually prints is driven in
// `commands.test.ts`, and that is where the real assertion lives. The first
// version of this feature had only the cases below, keyed on the wrong status,
// and they passed — a predicate exercised by hand cannot tell you the branch is
// reachable from the path that matters.
describe("signInAgainMessage", () => {
  // 403 is what `GET /auth/v1/user` answers for a revoked session, measured
  // against a real stack. It is also what it answers for a damaged token, which
  // is why the sentence names the remedy they share rather than asserting one.
  it("99-S4: a 403 is the credentials no longer being accepted", () => {
    expect(signInAgainMessage(403)).toBe(SESSION_NOT_ACCEPTED_MESSAGE);
  });

  // Kept, though the caller cannot produce it: that endpoint answers 401 only
  // when no bearer was sent at all, and this one always sends the token it holds.
  it("99-S4: and so is a 401, which costs nothing to keep", () => {
    expect(signInAgainMessage(401)).toBe(SESSION_NOT_ACCEPTED_MESSAGE);
  });

  // Sending somebody to `mdbrain login` over a server fault wastes their time on
  // something logging in again cannot touch.
  it("99-S5: nothing else is", () => {
    for (const status of [200, 404, 429, 500, 502]) {
      expect(signInAgainMessage(status)).toBeNull();
    }
  });
});
