import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RUNNER_VERSION_HEADER,
  TOO_OLD_STATUS,
  startupVerdict,
  tooOldText,
  versionHeader,
  type StartupAnswer,
} from "../src/upgrade/floor.ts";
import { RUNNING_RUN_NOTICE } from "../src/upgrade/plan.ts";
import { SAID_LIMIT } from "../src/run/diagnosis.ts";
import { signInAgainMessage } from "../src/auth/session.ts";
import { askForCount, askToStart } from "../src/auth/api.ts";
import { VERSION } from "../src/version.ts";

const SAID = "This mdbrain is too old for this server. It reported 0.3.0, and the oldest this server accepts is 0.4.0.";

const answered = (over: Partial<Extract<StartupAnswer, { kind: "answered" }>> = {}): StartupAnswer => ({
  kind: "answered",
  status: TOO_OLD_STATUS,
  said: SAID,
  minimum: "0.4.0",
  sent: "0.3.0",
  ...over,
});

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

interface Call {
  url: string;
  method: string;
  headers: Headers;
  /** Every header name the request carried, so an addition to them is visible. */
  names: string[];
  /** Whatever bounds the request, or undefined when nothing does. */
  signal: AbortSignal | null | undefined;
}

/** Run `body` with `fetch` answered by `reply`, recording what was actually sent. */
async function withFetch<T>(
  reply: () => Response,
  body: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const names: string[] = [];
    headers.forEach((_value, name) => names.push(name));
    calls.push({ url: String(input), method: init?.method ?? "GET", headers, names, signal: init?.signal });
    return Promise.resolve(reply());
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

describe("the version this runner names itself with", () => {
  it("128-S11: the header carries the version and nothing else", () => {
    const header = versionHeader("0.4.1");
    expect(header).toEqual({ [RUNNER_VERSION_HEADER]: "0.4.1" });
    const value = JSON.stringify(header);
    for (const leaked of ["direct", "homebrew", "scoop", "linux", "darwin", "win32", "node", "bun", "x64"]) {
      expect(value).not.toContain(leaked);
    }
  });

  it("128-S11: and the call the floor is asked on sends exactly that, beside the credential", async () => {
    await withFetch(
      () => new Response(JSON.stringify({ mayStart: true }), { status: 200 }),
      async (calls) => {
        await askToStart("a-token");
        // Bounded, because it is asked in front of everything else the command
        // does: a host that never answers must cost seconds, not minutes.
        expect(calls[0].signal).toBeInstanceOf(AbortSignal);
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe("GET");
        expect(calls[0].headers.get(RUNNER_VERSION_HEADER)).toBe(VERSION);
        // Every other header is one the request already had to carry, so the
        // version is the only thing this build newly tells the server about itself.
        expect(calls[0].names.sort()).toEqual(
          ["authorization", "content-type", RUNNER_VERSION_HEADER].sort(),
        );
      },
    );
  });

  it("128-S11: the polled calls name it too, which is how a server can see what its fleet is", async () => {
    // The floor is enforced on the startup route alone, but the version rides
    // on every call the app answers — a server that cannot see what is out
    // there has no way to choose a floor worth setting.
    await withFetch(
      () => new Response(JSON.stringify({ waiting: 0, capped: false }), { status: 200 }),
      async (calls) => {
        await askForCount("a-token", ["dev-bot-mdden"]);
        expect(calls[0].headers.get(RUNNER_VERSION_HEADER)).toBe(VERSION);
      },
    );
  });

  it("128-S1: a refusal is read back with the server's words and the floor it named", async () => {
    await withFetch(
      () =>
        new Response(JSON.stringify({ error: SAID, minimum: "0.4.0", sent: "0.3.0" }), {
          status: TOO_OLD_STATUS,
          headers: { "content-type": "application/json" },
        }),
      async () => {
        expect(await askToStart("a-token")).toEqual({ status: TOO_OLD_STATUS, said: SAID, minimum: "0.4.0", sent: "0.3.0" });
      },
    );
  });

  it("128-S1: a refusal that is not JSON is still carried, with no floor claimed", async () => {
    await withFetch(
      () => new Response("<html>Gateway</html>", { status: TOO_OLD_STATUS }),
      async () => {
        expect(await askToStart("a-token")).toEqual({
          status: TOO_OLD_STATUS,
          said: "<html>Gateway</html>",
          minimum: null,
          sent: null,
        });
      },
    );
  });
});

describe("what a runner does with the server's answer", () => {
  it("128-S1: a refusal says what is wrong, what to do, and what a running runner keeps", () => {
    const verdict = startupVerdict(answered(), "direct", true);
    expect(verdict.kind).toBe("too-old");
    if (verdict.kind !== "too-old") return;
    expect(verdict.message).toContain("too old");
    expect(verdict.message).toContain("0.3.0");
    expect(verdict.message).toContain("0.4.0");
    expect(verdict.message).toContain("mdbrain upgrade");
    expect(verdict.message).toContain(RUNNING_RUN_NOTICE);
    expect(verdict.minimum).toBe("0.4.0");
  });

  it("128-S2: it is not a session problem, and the word login is nowhere in it", () => {
    const verdict = startupVerdict(answered(), "direct", true);
    if (verdict.kind !== "too-old") throw new Error("expected a refusal");
    expect(verdict.message.toLowerCase()).not.toContain("login");
    expect(verdict.message.toLowerCase()).not.toContain("sign in");
    // The sentence the session branch would have produced is never reached,
    // because 426 is not one of the two statuses that branch claims.
    expect(signInAgainMessage(TOO_OLD_STATUS, "mdbrain run")).toBeNull();
  });

  it("128-S7: the remedy is the one for this install, never a hardcoded command", () => {
    const remedy = (channel: Parameters<typeof tooOldText>[1], isCompiled: boolean) =>
      tooOldText(SAID, channel, isCompiled);
    expect(remedy("homebrew", true)).toContain("brew upgrade");
    expect(remedy("homebrew", true)).not.toContain("mdbrain upgrade");
    expect(remedy("scoop", true)).toContain("scoop update");
    expect(remedy("scoop", true)).not.toContain("mdbrain upgrade");
    expect(remedy("direct", false)).toContain("git");
    expect(remedy("direct", true)).toContain("mdbrain upgrade");
    // Whatever the install, the caveat is the same and is always there.
    for (const text of [remedy("homebrew", true), remedy("scoop", true), remedy("direct", false), remedy("direct", true)]) {
      expect(text).toContain(RUNNING_RUN_NOTICE);
    }
  });

  it("128-S4: only a refusal refuses — silence, an error and an unreachable route all start", () => {
    expect(startupVerdict({ kind: "unasked", detail: "fetch failed" }, "direct", true)).toEqual({ kind: "start" });
    expect(startupVerdict(answered({ status: 500, said: "boom" }), "direct", true)).toEqual({ kind: "start" });
    expect(startupVerdict(answered({ status: 404, said: "Not Found" }), "direct", true)).toEqual({ kind: "start" });
    expect(startupVerdict(answered({ status: 401, said: "Sign in." }), "direct", true)).toEqual({ kind: "start" });
    expect(startupVerdict(answered({ status: 200, said: "" }), "direct", true)).toEqual({ kind: "start" });
  });

  it("128-S2: the server's words are redacted and capped before they are shown", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF-_123";
    const verdict = startupVerdict(
      answered({ said: `refused\n  upstream: Authorization: Bearer ${token}` }),
      "direct",
      true,
    );
    if (verdict.kind !== "too-old") throw new Error("expected a refusal");
    expect(verdict.message).not.toContain(token);
    expect(verdict.message).toContain("[redacted]");
    expect(verdict.message).not.toContain("\n");
    const long = startupVerdict(answered({ said: "x".repeat(SAID_LIMIT + 200) }), "direct", true);
    if (long.kind !== "too-old") throw new Error("expected a refusal");
    expect(long.message.length).toBeLessThan(SAID_LIMIT + 300);
  });

  it("128-S1: a refusal with no words in it still says something, and still says the rest", () => {
    const verdict = startupVerdict(answered({ said: "" }), "direct", true);
    if (verdict.kind !== "too-old") throw new Error("expected a refusal");
    expect(verdict.message).toContain("too old");
    expect(verdict.message).toContain("mdbrain upgrade");
    expect(verdict.message).toContain(RUNNING_RUN_NOTICE);
  });
});

describe("which commands ask the question at all", () => {
  it("128-S9: only the command that takes work asks, so the remedy is never behind the fault", () => {
    // `configure` is the one that matters: it is what somebody runs while fixing
    // a broken install, and it mints the connection key. A floor reaching it
    // would lock the remedy behind the fault.
    for (const command of ["configure", "whoami", "login", "logout", "upgrade", "as"]) {
      expect(source(`../src/commands/${command}.ts`)).not.toContain("askToStart");
    }
    expect(source("../src/commands/run.ts")).toContain("askToStart");
  });

  it("128-S3: the two polled calls carry no floor, and neither does the tick", () => {
    // The property the ruling rests on: a run already going is never refused for
    // being old, because nothing on the polling path consults a verdict.
    // Both regions are found by an anchor, and an anchor that stops matching
    // takes `indexOf` to -1 and `slice` to the file's last character — which
    // contains none of the things below and passes every assertion in the case.
    // A region this claim rests on has to be asserted before it is read.
    const api = source("../src/auth/api.ts");
    const polled = api.indexOf("export async function askForCount");
    expect(polled).toBeGreaterThan(-1);
    const startupOnly = api.slice(polled);
    expect(startupOnly).toContain("/api/events/claim");
    expect(startupOnly).not.toContain("TOO_OLD_STATUS");
    expect(startupOnly).not.toContain("startupVerdict");
    const run = source("../src/commands/run.ts");
    const tickAt = run.indexOf("const tick = async");
    expect(tickAt).toBeGreaterThan(-1);
    const tick = run.slice(tickAt);
    expect(tick).toContain("deps.claim");
    expect(tick).not.toContain("askToStart");
    expect(tick).not.toContain("startupVerdict");
  });
});
