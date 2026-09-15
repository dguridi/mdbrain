import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { login } from "../src/commands/login.ts";
import { logout } from "../src/commands/logout.ts";
import { whoami } from "../src/commands/whoami.ts";
import { readySession } from "../src/commands/session.ts";
import { loadSession } from "../src/auth/store.ts";

interface Call {
  url: string;
  authorization: string | undefined;
}

/**
 * Run `body` with `fetch` answered by `reply`, and with the state root pointed
 * at a fresh directory holding `session` — so a command can be driven end to end
 * without a network, a stack, or the developer's own signed-in session.
 */
async function withRuntime<T>(
  session: unknown,
  reply: (url: string) => Response,
  body: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const state = mkdtempSync(join(tmpdir(), "mdbrain-cmd-"));
  const previousState = process.env.MDBRAIN_STATE_DIR;
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  process.env.MDBRAIN_STATE_DIR = state;
  if (session !== undefined) {
    writeFileSync(join(state, "session.json"), JSON.stringify(session));
  }
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization") ?? undefined });
    return Promise.resolve(reply(url));
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousState === undefined) delete process.env.MDBRAIN_STATE_DIR;
    else process.env.MDBRAIN_STATE_DIR = previousState;
    rmSync(state, { recursive: true, force: true });
  }
}

const lines = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { positional: [], flags: {}, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const EXPIRED = { accessToken: "an-hour-old", refreshToken: "rt", expiresAt: 1_000_000 };

describe("logout", () => {
  // The ordinary logout is signed in yesterday, out today, and the access token
  // on disk expired an hour into that. Revoking with it would be refused, and
  // the refresh token it was protecting deleted a line later.
  it("96-S40: an expired access token is refreshed before the revocation, not presented to it", async () => {
    await withRuntime(
      EXPIRED,
      (url) =>
        url.includes("grant_type=refresh_token")
          ? json({ access_token: "a-fresh-one", refresh_token: "rt2", expires_at: 9_000_000_000 })
          : new Response(null, { status: 204 }),
      async (calls) => {
        const { out, io } = lines();
        expect(await logout.run(io)).toBe(0);
        expect(calls.map((c) => c.url.includes("grant_type=refresh_token") ? "refresh" : "logout")).toEqual([
          "refresh",
          "logout",
        ]);
        expect(calls[1].authorization).toBe("Bearer a-fresh-one");
        expect(out.join(" ")).toContain("revoked");
        expect(await loadSession()).toEqual({ kind: "none" });
      },
    );
  });

  // A refused refresh is the server saying the session is already over, so there
  // is nothing left to revoke — which is a different sentence from "the server
  // was not told".
  it("96-S40a: a session the server has already ended is reported as ended, not as merely forgotten", async () => {
    await withRuntime(
      EXPIRED,
      () => json({ error: "invalid_grant" }, 400),
      async () => {
        const { out, err, io } = lines();
        expect(await logout.run(io)).toBe(0);
        expect(out.join(" ")).toContain("already ended this session");
        expect(err).toHaveLength(0);
      },
    );
  });

  it("96-S40b: a server that cannot be reached leaves the weaker outcome said out loud", async () => {
    await withRuntime(
      EXPIRED,
      () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        const { out, err, io } = lines();
        expect(await logout.run(io)).toBe(0);
        expect(out.join(" ")).toContain("Signed out locally");
        expect(err.join(" ")).toContain("may still be live");
        // The file is already gone by now, so quoting the refresh's own
        // "try again when the connection is back" would name a remedy that no
        // longer exists.
        expect(err.join(" ")).not.toContain("try again");
      },
    );
  });
});

describe("the refresh every command does first", () => {
  // A refusal and an unreachable server mean opposite things, and only one of
  // them is a reason to sign in again.
  it("96-S5a: a refused refresh says the session has ended", async () => {
    await withRuntime(EXPIRED, () => json({ error: "invalid_grant" }, 400), async () => {
      const outcome = await readySession();
      expect(outcome).toMatchObject({ kind: "stop", reason: "refreshed-away" });
      expect((outcome as { message: string }).message).toContain("has ended");
    });
  });

  it("96-S35: a refresh that never reached an answer says the session has not ended", async () => {
    await withRuntime(
      EXPIRED,
      () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        const outcome = await readySession();
        expect(outcome).toMatchObject({ kind: "stop", reason: "unreachable" });
        const message = (outcome as { message: string }).message;
        expect(message).toContain("has not ended");
        expect(message).not.toContain("signed out from the app");
      },
    );
  });
});

describe("reading the stored session", () => {
  it("96-S36: a session that exists and cannot be read is unreadable, never absent", async () => {
    const state = mkdtempSync(join(tmpdir(), "mdbrain-read-"));
    const previous = process.env.MDBRAIN_STATE_DIR;
    process.env.MDBRAIN_STATE_DIR = state;
    try {
      // A directory where the file goes is the portable stand-in for the errors
      // that actually occur — a permission change, a lock, a sharing violation.
      // What matters is that it is not ENOENT.
      mkdirSync(join(state, "session.json"));
      expect(await loadSession()).toEqual({ kind: "unreadable" });
    } finally {
      if (previous === undefined) delete process.env.MDBRAIN_STATE_DIR;
      else process.env.MDBRAIN_STATE_DIR = previous;
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("login's flags", () => {
  // Somebody passes `--port` because a firewall rule or a pasted address needs
  // the same port every time. Handing them a random one is the failure the flag
  // exists to prevent, so it has to be an error rather than a fallback.
  it("96-S37: --port with no number is refused rather than quietly floating", async () => {
    // `--port` alone parses to `true`; `--port=` parses to an empty string. Both
    // used to fall through to a floating port, which is the one outcome somebody
    // passing this flag is trying to avoid.
    for (const asked of [true, ""] as const) {
      const { err, io } = lines();
      const result = await login.run({ ...io, flags: { port: asked } });
      expect(result).toBe(1);
      expect(err.join(" ")).toContain("--port needs a port number");
    }
  });

  it("96-S37a: a port outside the range is refused, and zero is not a way in", async () => {
    for (const asked of ["0", "-1", "70000", "eight"]) {
      const { err, io } = lines();
      expect(await login.run({ ...io, flags: { port: asked } })).toBe(1);
      expect(err.join(" ")).toContain("--port must be a port number");
    }
  });
});

describe("what login exits with", () => {
  /**
   * Post a handover to the listener the running command has just opened, using
   * `node:http` rather than `fetch` because `fetch` is the thing `withRuntime`
   * has replaced — this request is the browser's, not the command's, and must
   * reach a real socket.
   */
  function postHandover(port: number, challenge: string): Promise<void> {
    const body = new URLSearchParams({
      challenge,
      access_token: "handed-over",
      refresh_token: "rt",
      expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    }).toString();
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/callback",
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  /** The address `login` printed, once it has printed one. */
  async function awaitLoginUrl(out: string[]): Promise<URL> {
    for (let i = 0; i < 200; i++) {
      const line = out.find((l) => l.includes("/cli-login?"));
      if (line) return new URL(line.trim());
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`login never printed an address: ${out.join(" | ")}`);
  }

  // The defect this exists for: the session is on disk by the time the account
  // is named, and that was read as "the login worked" whatever the naming call
  // came back with. A 403 is the server saying the session is not one, so a
  // script that trusts the exit code was told the opposite of the truth.
  it("96-S54: a handed-over session the server refuses is not a successful login", async () => {
    await withRuntime(undefined, () => json({ message: "invalid claim: missing sub" }, 403), async () => {
      const { out, err, io } = lines();
      const running = login.run({ ...io, flags: { "no-browser": true } });
      const url = await awaitLoginUrl(out);
      await postHandover(Number(url.searchParams.get("port")), url.searchParams.get("challenge")!);
      expect(await running).toBe(1);
      expect(err.join(" ")).toContain("is not accepted");
      expect(err.join(" ")).toContain("invalid claim: missing sub");
      expect(err.join(" ")).toContain("mdbrain login");
    });
  });

  // The other side of the same branch, and the reason the status is consulted
  // rather than the mere presence of an error: the session is on disk and will
  // refresh on the next command, so sending somebody back through a login they
  // have already done would be wrong.
  it("96-S54a: a naming call that could not be made is still a successful login", async () => {
    await withRuntime(undefined, () => { throw new TypeError("fetch failed"); }, async () => {
      const { out, err, io } = lines();
      const running = login.run({ ...io, flags: { "no-browser": true } });
      const url = await awaitLoginUrl(out);
      await postHandover(Number(url.searchParams.get("port")), url.searchParams.get("challenge")!);
      expect(await running).toBe(0);
      expect(err.join(" ")).toContain("could not be named");
      expect(out.join(" ")).toContain("Session stored at");
    });
  });
});

// A session that has NOT expired, so `sessionAction` says "use it" and the
// refusal arrives mid-command rather than at a refresh. That ordering is the
// whole subject of these cases.
const LIVE = { accessToken: "still-valid", refreshToken: "rt", expiresAt: Math.floor(Date.now() / 1000) + 3600 };

// What GoTrue actually answers `GET /auth/v1/user` for a token whose session was
// revoked, measured against a real stack rather than assumed: **403**, with this
// message. An earlier version of this feature keyed on 401 and could therefore
// never fire — and the tests did not catch it, because they exercised the
// predicate by hand instead of the path a command takes.
const REVOKED = { code: 403, msg: "Session from session_id claim in JWT does not exist" };

describe("whoami when the session was ended somewhere else", () => {
  const runWhoami = (reply: (url: string) => Response) => {
    const io = lines();
    return withRuntime(LIVE, reply, async () => ({ code: await whoami.run(io.io as never), io }));
  };

  it("99-S4: says the request was refused rather than blaming the roster", async () => {
    const { code, io } = await runWhoami((url) =>
      url.includes("/auth/v1/user") ? json(REVOKED, 403) : json([]));
    expect(code).toBe(1);
    const said = io.err.join("\n");
    expect(said).toContain("refused this request");
    expect(said).toContain("mdbrain login");
    expect(said).not.toContain("Could not read the roster");
  });

  // 99-S11 driven through the command rather than the builder: which command the
  // sentence names is the call site's decision, so the call site is where a wrong
  // one would ship. Sending somebody to `mdbrain login` first costs a
  // re-authentication that the retry usually makes unnecessary.
  it("99-S11: recommends running `whoami` again before re-authenticating", async () => {
    const { io } = await runWhoami((url) =>
      url.includes("/auth/v1/user") ? json(REVOKED, 403) : json([]));
    const said = io.err.join("\n");
    expect(said.indexOf("mdbrain whoami")).toBeGreaterThan(-1);
    expect(said.indexOf("mdbrain whoami")).toBeLessThan(said.indexOf("mdbrain login"));
  });

  it("99-S4: and keeps the server's own words, since the status cannot say which cause it was", async () => {
    const { io } = await runWhoami((url) =>
      url.includes("/auth/v1/user") ? json(REVOKED, 403) : json([]));
    expect(io.err.join("\n")).toContain("Session from session_id claim in JWT does not exist");
  });

  // Kept, but not kept raw. The body is written by whatever answered — the app's
  // route, or a proxy that echoed the request and the bearer with it — and this
  // line goes to a terminal and from there into whatever people paste when they
  // ask for help. `run`'s roster read is asserted this way already; the claim is
  // put here to the call site that prints it, because redacting is the call
  // site's decision and a site that forgets is what ships the token.
  it("99-S4: and redacts anything credential-shaped out of them first", async () => {
    const signature = "c2lnbmF0dXJlX2hlcmU";
    const leaked = `${REVOKED.msg} (eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${signature})`;
    const { io } = await runWhoami((url) =>
      url.includes("/auth/v1/user") ? json({ code: 403, msg: leaked }, 403) : json([]));
    const said = io.err.join("\n");
    expect(said).toContain("[redacted]");
    expect(said).not.toContain(signature);
    // And the ordinary words survive, or the redaction would have taken the
    // reason with the token and left the person nothing to read.
    expect(said).toContain("Session from session_id claim in JWT does not exist");
  });

  // The failure the sentence must NOT claim. A server fault is not a signed-out
  // session, and sending somebody to `mdbrain login` over it wastes their time on
  // something logging in again cannot touch.
  it("99-S5: a server fault keeps the roster wording rather than blaming the session", async () => {
    const { code, io } = await runWhoami((url) =>
      url.includes("/auth/v1/user") ? json({ msg: "internal error" }, 500) : json([]));
    expect(code).toBe(1);
    expect(io.err.join("\n")).toContain("Could not read the roster");
    // Named rather than the old wording, which this sentence no longer contains:
    // an assertion against a phrase nothing can produce passes without measuring.
    expect(io.err.join("\n")).not.toContain("mdbrain login");
  });
});
