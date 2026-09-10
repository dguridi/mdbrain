import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch, parseArgv, renderHelp } from "../src/cli.ts";
import { COMMANDS, VERSION } from "../src/main.ts";
import { groupRoster, renderRoster } from "../src/commands/roster.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const org = (id: string, name: string) => ({ id, name });
const agent = (id: string, orgId: string, name: string, status = "active") => ({
  id,
  org_id: orgId,
  display_name: name,
  status,
});

describe("the command line", () => {
  it("96-S22: --help lists every command the binary has", async () => {
    const { out, io } = capture();
    expect(await dispatch(["--help"], COMMANDS, VERSION, io)).toBe(0);
    const help = out.join("\n");
    for (const command of COMMANDS) expect(help).toContain(command.name);
    expect(COMMANDS.map((c) => c.name)).toEqual(["login", "whoami", "logout", "configure", "run", "upgrade"]);
  });

  it("96-S22a: every command carries a summary, so help cannot go stale silently", () => {
    for (const command of COMMANDS) expect(command.summary.length).toBeGreaterThan(0);
    expect(renderHelp(COMMANDS, VERSION)).toContain(VERSION);
  });

  it("109-S3: --version prints the bare version, which is what the release smoke test compares to the tag", async () => {
    // The release workflow tests `mdbrain --version` against the tag with a
    // string equality, so a decorated answer — `mdbrain 0.2.0`, the shape
    // `renderHelp` right above already uses — would fail the release after
    // seven cross-compiles at tag time rather than failing here. `VERSION` is
    // the constant the release binds, so it is what goes in, and the whole of
    // what must come out.
    for (const flag of ["--version", "-v"]) {
      const { out, err, io } = capture();
      expect(await dispatch([flag], COMMANDS, VERSION, io), flag).toBe(0);
      expect(out, flag).toEqual([VERSION]);
      expect(err, flag).toEqual([]);
    }
  });

  it("96-S22b: an unknown command is refused with its own exit code", async () => {
    const { err, io } = capture();
    expect(await dispatch(["nonsense"], COMMANDS, VERSION, io)).toBe(2);
    expect(err.join("\n")).toContain("nonsense");
  });

  // A flag only swallows the next word when the command says it takes one, or
  // `login --provider` would eat whatever followed it.
  it("96-S22c: a value flag consumes its value and a bare flag does not", () => {
    expect(parseArgv(["login", "--provider", "github"], new Set(["provider"]))).toMatchObject({
      command: "login",
      flags: { provider: "github" },
    });
    expect(parseArgv(["login", "--provider", "github"]).flags).toMatchObject({ provider: true });
  });
});

describe("signing in is never silent", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/commands/login.ts", import.meta.url)),
    "utf8",
  );

  // 96-S26 — the convention every CLI people already use holds to: `gcloud auth
  // login` sends prompt=consent, `gh auth login` makes you paste a one-time
  // code. Neither ever signs you in without showing you something. Here that is
  // structural rather than a parameter: the browser goes to the app's own page,
  // which does not hand anything over until its button is pressed. What this
  // guards is that it goes there at all — sending it to an identity provider
  // instead would reintroduce both the silence and the accounts that have no
  // provider to be sent to.
  it("96-S26: the login opens the app's own page, not an identity provider", () => {
    // Comments stripped for the same reason 96-S24 strips them: the prose above
    // this code explains why there is no provider, and a tripwire that could not
    // tell an explanation from a call would forbid explaining itself.
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(code).toContain('new URL("/cli-login", APP_URL)');
    expect(code).not.toContain("/auth/v1/authorize");
    expect(code).not.toContain("provider");
  });

  // The challenge is what ties the page's answer to this command, so it has to
  // be in the address the browser is opened at, and the verifier must not be.
  it("96-S26b: the address carries the challenge and never the verifier", () => {
    expect(source).toContain('url.searchParams.set("challenge", challenge)');
    expect(source).not.toMatch(/searchParams\.set\([^)]*verifier/);
  });

  // The address is the real interface where there is no browser to launch.
  it("96-S26a: the address is printed whether or not it is opened", () => {
    expect(source).toContain("if (launch) openBrowser(url)");
    expect(source).toMatch(/out\(`  \$\{url\}`\)/);
  });
});

describe("handing a URL to the operating system", () => {
  // 96-S23 — the failure this pins is silent and looks like success. `cmd` reads
  // `&` as a command separator, so an unquoted authorization URL reaches the
  // browser truncated at its first parameter: no redirect_to, no code_challenge.
  // The server then signs the person in at the project's own site while the
  // listener waits forever for a callback that was never asked for.
  // Windows-only because it spawns `cmd`: there is none on the Linux runner, and
  // `spawnSync` there returns no stdout at all rather than a failing comparison.
  // What this leaves uncovered elsewhere is covered by 96-S23a, which asks the
  // same question of the arguments rather than of the shell.
  it.skipIf(process.platform !== "win32")("96-S23: a URL full of ampersands survives the Windows launcher", () => {
    const url =
      "https://p.supabase.co/auth/v1/authorize?provider=google&redirect_to=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback&code_challenge=ABC&code_challenge_method=S256";
    const received = spawnSync("cmd", ["/c", "echo", `"${url}"`], {
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    expect(received.stdout.trim().replace(/^"|"$/g, "")).toBe(url);
    expect(received.stderr.trim()).toBe("");

    // And the shape without the quoting, so the test says what it is guarding.
    const truncated = spawnSync("cmd", ["/c", "echo", url], { encoding: "utf8" });
    expect(truncated.stdout.trim()).not.toBe(url);
  });
});

describe("how the process ends", () => {
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

  // 96-S24 — a source tripwire, because the failure is invisible in a unit test
  // and the fix looks like an oversight. `process.exit()` after a `fetch` races
  // undici's teardown and aborts on Windows, which replaces the exit code with
  // 127 — so a command that worked reports failure to whatever ran it.
  it("96-S24: the entry point sets an exit code rather than calling process.exit", () => {
    const source = readFileSync(entry, "utf8");
    // Comments are stripped first: the one above this very code names
    // `process.exit()` in order to warn against it, and a tripwire that could
    // not tell an explanation from a call would forbid explaining itself.
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("process.exitCode = code");
    expect(code).not.toMatch(/process\.exit\(/);
  });

  // The whole program, started as a program: it runs, says the right thing, and
  // ends with a status a script can read.
  it("96-S24a: a signed-out logout exits 0 and aborts nothing", () => {
    const state = mkdtempSync(join(tmpdir(), "mdbrain-test-"));
    try {
      const run = spawnSync(process.execPath, [entry, "logout"], {
        encoding: "utf8",
        env: { ...process.env, MDBRAIN_STATE_DIR: state },
      });
      expect(run.stdout).toContain("not signed in");
      expect(run.stderr).not.toContain("Assertion failed");
      expect(run.status).toBe(0);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("the roster whoami prints", () => {
  // 96-S6's shape, decided without a network.
  it("96-S6a: groups each agent under its organization", () => {
    const groups = groupRoster(
      [org("o1", "markdownbrain.ai"), org("o2", "Another Org")],
      [agent("a1", "o1", "dev-bot"), agent("a2", "o2", "critic"), agent("a3", "o1", "warden")],
    );
    expect(groups).toEqual([
      { organization: "markdownbrain.ai", agents: ["dev-bot", "warden"] },
      { organization: "Another Org", agents: ["critic"] },
    ]);
  });

  // Dropping it would make an empty roster look like not being a member.
  it("96-S6b: an organization with no agents is kept", () => {
    expect(groupRoster([org("o1", "Empty")], [])).toEqual([{ organization: "Empty", agents: [] }]);
    expect(renderRoster("me@example.com", groupRoster([org("o1", "Empty")], []))).toContain("  (no agents)");
  });

  // Two reads can disagree; silently dropping rows would hide that.
  it("96-S6c: an agent whose organization is not in the list is kept and labelled", () => {
    const groups = groupRoster([org("o1", "Mine")], [agent("a1", "o-missing", "stray")]);
    expect(groups).toHaveLength(2);
    expect(groups[1].agents).toEqual(["stray"]);
    expect(groups[1].organization).toContain("cannot read");
  });

  it("96-S6d: a disabled agent says so rather than looking active", () => {
    const groups = groupRoster([org("o1", "Mine")], [agent("a1", "o1", "old-bot", "disabled")]);
    expect(groups[0].agents).toEqual(["old-bot (disabled)"]);
  });

  it("96-S6e: an account in no organization is told so, not shown nothing", () => {
    expect(renderRoster("me@example.com", []).join("\n")).toContain("No organizations");
  });
});
