import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { browserLaunch, listenForSession } from "../src/auth/listen.ts";
import { signOutLocal } from "../src/auth/api.ts";

const CHALLENGE = "a-challenge-derived-from-this-logins-verifier";
const GOOD = {
  challenge: CHALLENGE,
  access_token: "at",
  refresh_token: "rt",
  expires_at: "1788000000",
};

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

interface Sent {
  path?: string;
  method?: string;
  origin?: string | null;
  contentType?: string | null;
  body?: string;
  /**
   * Send the body in two writes, pausing this long between them.
   *
   * The only way to hold a request inside `readBody` while another one arrives:
   * with `content-length` announced, the server waits for the rest, so the
   * handler is parked mid-`await` exactly where a check-then-act guard is
   * unsafe. Without it two requests from one process are served in turn and no
   * interleaving happens at all.
   */
  stallMs?: number;
}

/**
 * A raw request to the listener, so the headers are the browser's rather than a
 * test helper's idea of them. `node:http` is used instead of `fetch` because
 * `Origin` is a header undici is entitled to have opinions about, and one case
 * here turns on the listener being indifferent to it.
 */
function send(port: number, sent: Sent = {}): Promise<{ status: number; text: string }> {
  const {
    path = "/callback",
    method = "POST",
    origin = null,
    contentType = "application/x-www-form-urlencoded",
    body = "",
    stallMs = 0,
  } = sent;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (contentType !== null) headers["content-type"] = contentType;
    if (origin !== null) headers.origin = origin;
    if (body) headers["content-length"] = Buffer.byteLength(body);
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    if (body && stallMs > 0) {
      const split = Math.max(1, Math.floor(body.length / 2));
      req.write(body.slice(0, split));
      setTimeout(() => {
        req.write(body.slice(split));
        req.end();
      }, stallMs);
      return;
    }
    if (body) req.write(body);
    req.end();
  });
}

/** Let the listener's own async handler run to completion before reading state. */
const settleIO = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the listener, driven over a socket", () => {
  // The refusals are decided in `handover.ts` and covered there against
  // hand-built inputs. What only a socket can say is whether the listener hands
  // that decision the request's own headers, and whether the wait survives being
  // talked to — so every case here goes through a real port.
  it("96-S9: nothing but this login's handover ends the wait", async () => {
    const reports: string[] = [];
    const loopback = await listenForSession(CHALLENGE, (line) => reports.push(line));
    try {
      let settled = false;
      void loopback.session.then(() => {
        settled = true;
      });

      // Each of these is a payload that would otherwise be a session.
      await send(loopback.port, { body: form({ ...GOOD, challenge: "someone-elses-login" }) });
      await send(loopback.port, { contentType: "application/json", body: JSON.stringify(GOOD) });
      const { access_token: _dropped, ...missingToken } = GOOD;
      await send(loopback.port, { body: form(missingToken) });
      // A GET carrying the whole handover in its query string: refused on the
      // method, which is also what keeps tokens out of a URL.
      await send(loopback.port, { method: "GET", path: `/callback?${form(GOOD)}` });
      await send(loopback.port, { method: "POST", path: "/", body: form(GOOD) });

      await settleIO();
      expect(settled).toBe(false);
      // 96-S32: every one of them said something. A request answered in silence
      // is one nobody can notice, and the GET above is the one worth noticing.
      expect(reports).toHaveLength(5);

      // The positive control: the same probe, sent correctly, is seen. Without
      // it a listener that refused everything would pass every line above.
      const accepted = await send(loopback.port, { body: form(GOOD) });
      expect(accepted.text).toContain("close this tab");
      await expect(loopback.session).resolves.toEqual({
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1788000000,
      });
    } finally {
      loopback.close();
    }
  });

  // Both are still reported — nothing reaches this listener in silence — but a
  // browser fetching a favicon on its way to the sign-in page happens on every
  // successful login, and it must not arrive wearing the sentence written for
  // tokens in a URL. A warning that fires when nothing is wrong is one nobody
  // reads the second time.
  it("96-S49a: browser noise and a GET at the callback are reported differently", async () => {
    const reports: string[] = [];
    const loopback = await listenForSession(CHALLENGE, (line) => reports.push(line));
    try {
      await send(loopback.port, { method: "GET", path: "/favicon.ico" });
      await send(loopback.port, { method: "GET", path: `/callback?${form(GOOD)}` });
      await settleIO();
      expect(reports).toHaveLength(2);
      expect(reports[0]).not.toEqual(reports[1]);
      expect(reports[1]).toMatch(/callback/i);
    } finally {
      loopback.close();
    }
  });

  // The measured reason the origin rule was removed rather than repaired: an
  // https page posting to an http loopback address is a downgrade, and Chrome
  // answers it by volunteering `Origin: null`. A listener that required the
  // app's origin refused the real handover and nothing else.
  it("96-S33: the handover lands whatever origin the browser volunteered", async () => {
    for (const origin of [null, "null", "https://markdown-den.com", "https://evil.example"]) {
      const loopback = await listenForSession(CHALLENGE, () => {});
      try {
        await send(loopback.port, { origin, body: form(GOOD) });
        await expect(loopback.session).resolves.toMatchObject({ accessToken: "at" });
      } finally {
        loopback.close();
      }
    }
  });

  // The challenge is the only guard, so a payload that carries it must be spent
  // by the first request that does. Anything local that watched one go past and
  // replayed it would otherwise be handed a second, later session.
  it("96-S31: the wait is one shot — a second handover is refused, not accepted", async () => {
    const reports: string[] = [];
    const loopback = await listenForSession(CHALLENGE, (line) => reports.push(line));
    try {
      await send(loopback.port, { body: form(GOOD) });
      await expect(loopback.session).resolves.toMatchObject({ accessToken: "at" });

      const replayed = await send(loopback.port, {
        body: form({ ...GOOD, access_token: "a-later-one" }),
      });
      await settleIO();
      expect(replayed.text).not.toContain("close this tab");
      expect(reports).toHaveLength(1);
      // The session promise keeps the first one: a replay cannot displace what
      // the command is about to store.
      await expect(loopback.session).resolves.toMatchObject({ accessToken: "at" });
    } finally {
      loopback.close();
    }
  });

  // The cap is the one path that cannot answer, because reaching it destroys the
  // socket. What must still happen is the report: an oversized payload is
  // exactly what somebody probing this would send, and it is the request least
  // able to afford passing in silence.
  it("96-S38: a body over the cap is reported rather than left hanging", async () => {
    const reports: string[] = [];
    const loopback = await listenForSession(CHALLENGE, (line) => reports.push(line));
    try {
      let settled = false;
      void loopback.session.then(() => {
        settled = true;
      });

      // The client sees the socket go away, which is not the assertion.
      await send(loopback.port, { body: form({ ...GOOD, access_token: "x".repeat(100 * 1024) }) }).catch(
        () => undefined,
      );

      await settleIO();
      expect(settled).toBe(false);
      expect(reports).toHaveLength(1);

      // And the listener is still able to take the real one afterwards.
      await send(loopback.port, { body: form(GOOD) });
      await expect(loopback.session).resolves.toMatchObject({ accessToken: "at" });
    } finally {
      loopback.close();
    }
  });

  // The guard is read before the body is awaited and written after, so two
  // handovers that overlap on the wire both used to pass it — a retried form
  // POST, a double submit, or something local racing the browser — and both were
  // told "signed in", with neither reported.
  it("96-S31a: two handovers racing each other still yield one, and the other is reported", async () => {
    const reports: string[] = [];
    const loopback = await listenForSession(CHALLENGE, (line) => reports.push(line));
    try {
      // The first is held mid-body so the second arrives while its handler is
      // parked inside `readBody` — which is the only arrangement in which the
      // guard is read before either has written it.
      const both = await Promise.all([
        send(loopback.port, { body: form(GOOD), stallMs: 60 }),
        (async () => {
          await new Promise((r) => setTimeout(r, 20));
          return send(loopback.port, { body: form({ ...GOOD, access_token: "the-second-one" }) });
        })(),
      ]);
      await settleIO();

      const accepted = both.filter((r) => r.text.includes("close this tab"));
      expect(accepted).toHaveLength(1);
      expect(reports).toHaveLength(1);
      await expect(loopback.session).resolves.toMatchObject({
        accessToken: expect.stringMatching(/^(at|the-second-one)$/) as unknown as string,
      });
    } finally {
      loopback.close();
    }
  });

  it("96-S10: a port already held is refused by name rather than waited on", async () => {
    const holder = await listenForSession(CHALLENGE, () => {});
    try {
      await expect(
        listenForSession(CHALLENGE, () => {}, holder.port),
      ).rejects.toThrow(String(holder.port));
    } finally {
      holder.close();
    }
  });

  it("96-S10a: the port it reports is the one it is listening on", async () => {
    const loopback = await listenForSession(CHALLENGE, () => {});
    try {
      expect(loopback.port).toBeGreaterThan(0);
      const answered = await send(loopback.port, { method: "GET", path: "/" });
      expect(answered.status).toBe(200);
    } finally {
      loopback.close();
    }
  });

  it("96-S9j: the wait ends when nobody comes back, rather than hanging", async () => {
    const loopback = await listenForSession(CHALLENGE, () => {}, 0, 30);
    await expect(loopback.session).rejects.toThrow(/Timed out/);
    loopback.close();
  });
});

describe("handing a URL to the operating system", () => {
  const url =
    "https://markdown-den.com/cli-login?port=57298&challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  // 96-S23's guard, asked of the argument construction rather than of `cmd`, so
  // it says something on the Linux runner where the suite actually gates a PR.
  it("96-S23a: the Windows invocation quotes the whole URL and asks for verbatim arguments", () => {
    const launch = browserLaunch("win32", url);
    expect(launch.command).toBe("cmd");
    expect(launch.windowsVerbatimArguments).toBe(true);
    // The URL is one quoted argument, ampersands and all. Unquoted, `cmd` reads
    // the first `&` as a command separator and the browser gets a truncation.
    expect(launch.args).toEqual(["/c", "start", '""', `"${url}"`]);
    expect(launch.args[3]).toContain("&challenge=");
  });

  it("96-S23b: elsewhere the URL is one argument and no quoting is invented", () => {
    expect(browserLaunch("darwin", url)).toEqual({
      command: "open",
      args: [url],
      windowsVerbatimArguments: false,
    });
    expect(browserLaunch("linux", url)).toEqual({
      command: "xdg-open",
      args: [url],
      windowsVerbatimArguments: false,
    });
  });
});

describe("ending the session on the server", () => {
  async function withFetch<T>(reply: () => Response, body: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(reply())) as typeof fetch;
    try {
      return await body();
    } finally {
      globalThis.fetch = original;
    }
  }

  // 96-S13 is the reason `logout` calls the server at all: deleting the file
  // alone leaves a refresh token a copy of that file could still use. A 401 says
  // the access token was not accepted — which is what an expired one always is —
  // so nothing was revoked, and reporting it as success is the one outcome the
  // revocation exists to prevent.
  it("96-S13a: a refused revocation is raised rather than counted as one", async () => {
    await withFetch(
      () =>
        new Response(JSON.stringify({ msg: "invalid JWT: token is expired" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      async () => {
        await expect(signOutLocal("an-expired-access-token")).rejects.toThrow(/expired/);
      },
    );
  });

  it("96-S13b: a revocation the server accepted is not an error", async () => {
    await withFetch(
      () => new Response(null, { status: 204 }),
      async () => {
        await expect(signOutLocal("a-live-access-token")).resolves.toBeUndefined();
      },
    );
  });
});
