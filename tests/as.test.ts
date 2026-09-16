import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { childEnvironment, claudeHarness, type Identity } from "../src/run/harness.ts";
import { releaseTerminalInput, runAttached, type ExecuteDeps } from "../src/run/execute.ts";
import { runAs, USAGE_MESSAGE, unknownAgentMessage, type AsDeps } from "../src/commands/as.ts";
import { ambiguousAgentMessage, pickerHeading, resolveAgent } from "../src/as/choose.ts";
import { agentPicker } from "../src/as/screen.ts";
import { render as renderInk } from "ink-testing-library";
import { noConfigMessage, UNREADABLE_CONFIG_MESSAGE } from "../src/commands/run.ts";
import { configPath } from "../src/config/paths.ts";
import { mcpConfigPath } from "../src/config/store.ts";
import type { CommandContext } from "../src/cli.ts";
import type { AgentEntry, Config } from "../src/config/schema.ts";
import { COMMANDS } from "../src/main.ts";

const cwd = process.platform === "win32" ? "C:\\work\\checkout" : "/work/checkout";

const identity = (over: Partial<Identity> = {}): Identity => ({
  sessionId: "3f2a0000-0000-4000-8000-000000000000",
  mcpConfigPath: "/cfg/mcp/dev-bot-mdden.json",
  cwd,
  harnessCredential: "sk-live",
  connectionKeyVariable: "MDBRAIN_KEY_DEV_BOT_MDDEN",
  connectionKey: "smd_agent_deadbeef_secret",
  parentEnv: { PATH: "/usr/bin" },
  ...over,
});

const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  id: "agent-1",
  harness: "claude",
  pollsWork: true,
  cwd,
  env: { harness: "MY_KEY", connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" },
  bounds: { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" },
  ...over,
});

const config = (agents: Record<string, AgentEntry> = { "dev-bot-mdden": entry() }): Config => ({
  version: 1,
  sessionsPerHour: null,
  agents,
});

interface Captured {
  lines: string[];
  errors: string[];
  started: { command: string; args: string[]; env: Record<string, string>; cwd: string }[];
  asked: { options: string[]; typed: string | null }[];
}

function harness(over: Partial<AsDeps> = {}) {
  const captured: Captured = { lines: [], errors: [], started: [], asked: [] };
  const context: CommandContext = {
    positional: ["dev-bot-mdden"],
    flags: {},
    out: (line) => captured.lines.push(line),
    err: (line) => captured.errors.push(line),
  };
  const deps: AsDeps = {
    env: { PATH: "/usr/bin", MY_KEY: "sk-live" },
    directoryExists: () => true,
    openKeyStore: () =>
      Promise.resolve({
        backend: { kind: "keychain", where: "the keychain" },
        get: () => Promise.resolve("smd_agent_deadbeef_secret"),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      } as unknown as Awaited<ReturnType<AsDeps["openKeyStore"]>>),
    loadConfiguration: () => Promise.resolve({ kind: "config", config: config() }),
    startSession: ({ spawnable, cwd: at }) => {
      captured.started.push({ ...spawnable, cwd: at });
      return Promise.resolve({ exitCode: 0, signal: null, spawnProblem: null });
    },
    // Nobody at the terminal unless a test says otherwise, so a path that would
    // have asked a question shows up as nothing started rather than as a hang.
    isTTY: false,
    pickAgent: (options, typed) => {
      captured.asked.push({ options, typed });
      return Promise.resolve(null);
    },
    newSessionId: () => "9a7b0000-0000-4000-8000-000000000001",
    ...over,
  };
  return { deps, context, captured };
}

describe("as: the identity, shared by both modes", () => {
  it("125-S1: identityArgs is the five flags and nothing else, whatever the bounds say", () => {
    const args = claudeHarness.identityArgs(identity());
    expect(args).toEqual([
      "--mcp-config",
      "/cfg/mcp/dev-bot-mdden.json",
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__markdown-den",
      "--permission-mode",
      "auto",
      "--session-id",
      "3f2a0000-0000-4000-8000-000000000000",
    ]);
  });

  it("125-S1: two entries whose bounds differ in every field answer the same but for the paths", () => {
    // Bounds are not on `Identity` at all, which is the point: the shared half
    // cannot vary with them because it cannot see them.
    const one = claudeHarness.identityArgs(identity({ mcpConfigPath: "/a.json", sessionId: "11110000-0000-4000-8000-000000000000" }));
    const two = claudeHarness.identityArgs(identity({ mcpConfigPath: "/b.json", sessionId: "22220000-0000-4000-8000-000000000000" }));
    expect(one.length).toBe(two.length);
    const differing = one.map((arg, i) => (arg === two[i] ? null : i)).filter((i) => i !== null);
    expect(differing).toEqual([1, 8]);
  });

  it("125-S2: the interactive argv is exactly identityArgs, with no --permission-prompts", () => {
    const built = claudeHarness.buildInteractive(identity());
    expect(built.args).toEqual(claudeHarness.identityArgs(identity()));
    expect(built.args).not.toContain("-p");
    expect(built.args).not.toContain("--output-format");
    expect(built.args).not.toContain("--max-turns");
    expect(built.args).not.toContain("--max-budget-usd");
    // Asserted by name because ruling 6 is an experiment: the day it is
    // reversed, this assertion is what has to be changed on purpose.
    expect(built.args).not.toContain("--permission-prompts");
  });

  it("125-S4: both builders contain every member of identityArgs", () => {
    const shared = claudeHarness.identityArgs(identity());
    const print = claudeHarness.build({ ...identity(), prompt: "Do it.", bounds: { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" } });
    const interactive = claudeHarness.buildInteractive(identity());
    for (const member of shared) {
      expect(print.args).toContain(member);
      expect(interactive.args).toContain(member);
    }
  });

  it("125-S4: the shared set appears contiguously in the print argv, so a flag cannot be dropped from between", () => {
    const shared = claudeHarness.identityArgs(identity());
    const print = claudeHarness.build({ ...identity(), prompt: "Do it.", bounds: { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" } });
    const at = print.args.indexOf(shared[0]);
    expect(print.args.slice(at, at + shared.length)).toEqual(shared);
  });

  it("125-S3: the print argv still carries the instruction and both bounds, which the split moved nothing of", () => {
    const bounds = { maxTurns: 7, maxBudgetUsd: 0.5, wallClock: "30m" };
    const print = claudeHarness.build({ ...identity(), prompt: "Triage what landed.", bounds });
    expect(print.args[0]).toBe("-p");
    expect(print.args[1]).toBe("Triage what landed.");
    // The two bounds flags, which nothing else in the suite reads. 125-S2
    // pins only their ABSENCE from the attended argv, and an absence cannot
    // see them leaving the other mode: without this, dropping either from
    // `build` leaves every case green while an unattended session — the one
    // nobody is watching — runs with no ceiling on turns or spend.
    expect(print.args[print.args.indexOf("--max-turns") + 1]).toBe("7");
    expect(print.args[print.args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
    expect(print.args[print.args.indexOf("--output-format") + 1]).toBe("json");
  });

  it("125-S5: the machine's own account removes ANTHROPIC_API_KEY from an interactive child", () => {
    const built = claudeHarness.buildInteractive(
      identity({ harnessCredential: null, parentEnv: { ANTHROPIC_API_KEY: "sk-left-in-the-shell", PATH: "/usr/bin" } }),
    );
    expect("ANTHROPIC_API_KEY" in built.env).toBe(false);
    expect(built.env.MDBRAIN_KEY_DEV_BOT_MDDEN).toBe("smd_agent_deadbeef_secret");
    expect(built.env.PATH).toBe("/usr/bin");
  });

  it("125-S6: an entry naming a harness variable carries its value into the interactive child", () => {
    const built = claudeHarness.buildInteractive(identity({ harnessCredential: "sk-from-my-var" }));
    expect(built.env.ANTHROPIC_API_KEY).toBe("sk-from-my-var");
  });

  it("125-S5/S6: childEnvironment takes an Identity, so both modes cannot diverge on it", () => {
    const shared = identity({ harnessCredential: null, parentEnv: { ANTHROPIC_API_KEY: "sk-shell", PATH: "/usr/bin" } });
    expect(claudeHarness.buildInteractive(shared).env).toEqual(childEnvironment(shared, "ANTHROPIC_API_KEY"));
  });

});

describe("as: startup and the refusals", () => {
  it("125-S8: the three broken-configuration sentences are run's own", async () => {
    for (const [loaded, expected] of [
      [{ kind: "none" as const }, noConfigMessage(configPath())],
      [{ kind: "unreadable" as const }, UNREADABLE_CONFIG_MESSAGE],
      [{ kind: "problem" as const, message: "agents.alice.cwd must be absolute." }, "agents.alice.cwd must be absolute."],
    ] as const) {
      const { deps, context, captured } = harness({ loadConfiguration: () => Promise.resolve(loaded) });
      expect(await runAs(deps, context)).toBe(1);
      expect(captured.errors).toEqual([expected]);
      expect(captured.started).toEqual([]);
    }
  });

  it("125-S9: no agent argument with nobody at the terminal is a usage sentence", async () => {
    const { deps, context, captured } = harness();
    context.positional = [];
    expect(await runAs(deps, context)).toBe(1);
    expect(captured.errors).toEqual([USAGE_MESSAGE]);
    expect(captured.asked).toEqual([]);
  });

  it("125-S9: a name that is not configured lists the ones that are and names configure", async () => {
    const { deps, context, captured } = harness();
    context.positional = ["nobody"];
    expect(await runAs(deps, context)).toBe(1);
    expect(captured.errors[0]).toBe(unknownAgentMessage("nobody", ["dev-bot-mdden"]));
    expect(captured.errors[0]).toContain("dev-bot-mdden");
    expect(captured.errors[0]).toContain("mdbrain configure");
  });

  it("125-S10: a missing directory and an unset variable are holdReason's own sentences", async () => {
    const missing = harness({ directoryExists: () => false });
    expect(await runAs(missing.deps, missing.context)).toBe(1);
    expect(missing.captured.errors[0]).toContain(`its directory ${cwd} is not there.`);

    const unset = harness({ env: { PATH: "/usr/bin" } });
    expect(await runAs(unset.deps, unset.context)).toBe(1);
    expect(unset.captured.errors[0]).toContain("MY_KEY is not set.");
  });

  it("125-S10: an agent in no roster is not held on that ground", async () => {
    // `as` reads no roster, so the third hold cannot apply however the entry
    // is named — the assertion is that it grew no second opinion about what
    // makes an entry unrunnable.
    const { deps, context, captured } = harness();
    context.positional = ["dev-bot-mdden"];
    expect(await runAs(deps, context)).toBe(0);
    expect(captured.errors).toEqual([]);
    expect(captured.started).toHaveLength(1);
  });

  it("125-S30: an identity-only entry starts exactly as one that is asked for work", async () => {
    const asked = harness();
    expect(await runAs(asked.deps, asked.context)).toBe(0);

    const identityOnly = harness({
      loadConfiguration: () => Promise.resolve({ kind: "config", config: config({ "dev-bot-mdden": entry({ pollsWork: false }) }) }),
    });
    expect(await runAs(identityOnly.deps, identityOnly.context)).toBe(0);
    expect(identityOnly.captured.errors).toEqual([]);
    // The same argv and the same checkout: `pollsWork` bounds the runner and
    // says nothing about what a session as this agent is.
    expect(identityOnly.captured.started[0].args).toEqual(asked.captured.started[0].args);
    expect(identityOnly.captured.started[0].cwd).toBe(asked.captured.started[0].cwd);
  });

  it("125-S11: a store holding nothing for the entry names configure, and a store that will not open is a different sentence", async () => {
    const empty = harness({
      openKeyStore: () =>
        Promise.resolve({ get: () => Promise.resolve(null) } as unknown as Awaited<ReturnType<AsDeps["openKeyStore"]>>),
    });
    expect(await runAs(empty.deps, empty.context)).toBe(1);
    expect(empty.captured.errors[0]).toContain("There is no connection key for dev-bot-mdden");
    expect(empty.captured.errors[0]).toContain("mdbrain configure");

    const broken = harness({ openKeyStore: () => Promise.reject(new Error("the keychain is locked")) });
    expect(await runAs(broken.deps, broken.context)).toBe(1);
    expect(broken.captured.errors[0]).toBe("Could not open the connection key store: the keychain is locked");
    expect(broken.captured.errors[0]).not.toContain("mdbrain configure");
  });

  it("125-S12: a connection key named ANTHROPIC_API_KEY is the collision refusal", async () => {
    const { deps, context, captured } = harness({
      loadConfiguration: () =>
        Promise.resolve({
          kind: "config",
          config: config({ "dev-bot-mdden": entry({ env: { harness: "MY_KEY", connectionKey: "ANTHROPIC_API_KEY" } }) }),
        }),
    });
    expect(await runAs(deps, context)).toBe(1);
    expect(captured.errors[0]).toContain("are both `ANTHROPIC_API_KEY`");
    expect(captured.errors[0]).toContain("One variable cannot hold both");
    expect(captured.started).toEqual([]);

    // The refusal sits between opening the store and reading from it, so a key
    // is never read for a session that is about to be refused. Without this the
    // two halves of the collision case are pinned and the order between them is
    // not: moving the check after the read leaves every other assertion green.
    let read = false;
    const ordered = harness({
      loadConfiguration: () =>
        Promise.resolve({
          kind: "config",
          config: config({ "dev-bot-mdden": entry({ env: { harness: "MY_KEY", connectionKey: "ANTHROPIC_API_KEY" } }) }),
        }),
      openKeyStore: () =>
        Promise.resolve({
          get: () => {
            read = true;
            return Promise.resolve("den-key");
          },
        } as unknown as Awaited<ReturnType<AsDeps["openKeyStore"]>>),
    });
    expect(await runAs(ordered.deps, ordered.context)).toBe(1);
    expect(ordered.captured.errors[0]).toContain("are both `ANTHROPIC_API_KEY`");
    expect(read).toBe(false);
  });

  it("125-S13: no human session is read, the session starts, and nothing is said about login state", async () => {
    const { deps, context, captured } = harness();
    // The assertion is the absence of the call rather than tolerance of its
    // failure: those look identical from the outside and only one was ruled.
    expect("session" in deps).toBe(false);
    expect(await runAs(deps, context)).toBe(0);
    expect(captured.started).toHaveLength(1);
    const said = [...captured.lines, ...captured.errors].join("\n");
    expect(said).not.toMatch(/sign|log ?in|session/i);
  });

  it("125-S2/S20: what the command spawns is the interactive argv, carrying the id it minted", async () => {
    const { deps, context, captured } = harness();
    expect(await runAs(deps, context)).toBe(0);
    const [started] = captured.started;
    expect(started.command).toBe("claude");
    // Against the builder rather than a restatement of the flags, so this cannot
    // pass by agreeing with a copy of the list that has drifted.
    expect(started.args).toEqual(
      claudeHarness.buildInteractive({
        sessionId: "9a7b0000-0000-4000-8000-000000000001",
        mcpConfigPath: mcpConfigPath("dev-bot-mdden"),
        cwd,
        harnessCredential: "sk-live",
        connectionKeyVariable: "MDBRAIN_KEY_DEV_BOT_MDDEN",
        connectionKey: "smd_agent_deadbeef_secret",
        parentEnv: deps.env,
      }).args,
    );
    // The minted id and not the entry's — `--session-id` refuses anything that is
    // not a UUID, so passing `entry.id` would fail at spawn and nothing that only
    // inspected the stub would notice.
    expect(started.args[started.args.indexOf("--session-id") + 1]).toBe("9a7b0000-0000-4000-8000-000000000001");
    expect(started.args).not.toContain("agent-1");
    // The named agent's OWN file, computed by the store rather than read back
    // out of the argv under test: an expectation taken from the value it is
    // checking cannot see this command handing the harness another agent's
    // connection, which is the one thing the per-agent MCP file decides.
    expect(started.args[started.args.indexOf("--mcp-config") + 1]).toBe(mcpConfigPath("dev-bot-mdden"));
    // The parent environment reaches the child, which is what puts `claude`
    // on its PATH at all; the two assertions below it are written by
    // `childEnvironment` from the identity and survive an empty one.
    expect(started.env.PATH).toBe("/usr/bin");
    expect(started.env.MDBRAIN_KEY_DEV_BOT_MDDEN).toBe("smd_agent_deadbeef_secret");
    expect(started.env.ANTHROPIC_API_KEY).toBe("sk-live");
  });

  it("125-S20: the real mint answers a distinct v4 UUID each time", () => {
    // The default dependency rather than the stand-in the cases above use, named
    // in the source so this cannot pass while the command mints something else.
    const source = readFileSync(fileURLToPath(new URL("../src/commands/as.ts", import.meta.url)), "utf8");
    expect(source).toContain("newSessionId: () => randomUUID()");
    const minted = new Set<string>();
    for (let i = 0; i < 10; i++) minted.add(randomUUID());
    expect(minted.size).toBe(10);
    for (const id of minted) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("125-S7: the session is spawned in the entry's cwd, not this process's", async () => {
    const elsewhere = process.platform === "win32" ? "C:\\other\\place" : "/other/place";
    const { deps, context, captured } = harness({
      loadConfiguration: () => Promise.resolve({ kind: "config", config: config({ "dev-bot-mdden": entry({ cwd: elsewhere }) }) }),
    });
    expect(await runAs(deps, context)).toBe(0);
    expect(captured.started[0].cwd).toBe(elsewhere);
    expect(captured.started[0].cwd).not.toBe(process.cwd());
  });
});

describe("as: it writes nothing", () => {
  it("125-S14: a complete invocation creates, modifies and removes no file under either root", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "mdbrain-as-config-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "mdbrain-as-state-"));
    const previous = { config: process.env.MDBRAIN_CONFIG_DIR, state: process.env.MDBRAIN_STATE_DIR };
    process.env.MDBRAIN_CONFIG_DIR = configRoot;
    process.env.MDBRAIN_STATE_DIR = stateRoot;

    /** Every file under a root, by path, with its size and mtime. */
    const snapshot = (root: string): Record<string, string> => {
      const seen: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full);
          else seen[relative(root, full)] = `${stat.size}:${stat.mtimeMs}`;
        }
      };
      if (existsSync(root)) walk(root);
      return seen;
    };

    try {
      mkdirSync(join(configRoot, "mcp"), { recursive: true });
      writeFileSync(join(configRoot, "config.json"), "{}\n");
      writeFileSync(join(configRoot, "mcp", "dev-bot-mdden.json"), "{}\n");
      writeFileSync(join(stateRoot, "runs.jsonl"), "");

      const before = { config: snapshot(configRoot), state: snapshot(stateRoot) };
      const { deps, context } = harness();
      expect(await runAs(deps, context)).toBe(0);
      const after = { config: snapshot(configRoot), state: snapshot(stateRoot) };

      expect(after.config).toEqual(before.config);
      expect(after.state).toEqual(before.state);
      expect(readFileSync(join(stateRoot, "runs.jsonl"), "utf8")).toBe("");
    } finally {
      for (const [name, value] of [["MDBRAIN_CONFIG_DIR", previous.config], ["MDBRAIN_STATE_DIR", previous.state]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(configRoot, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("125-S15: the command takes only loadConfig and mcpConfigPath from the config store, and no log at all", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/commands/as.ts", import.meta.url)), "utf8");
    const storeImport = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/config\/store\.ts"/.exec(source);
    expect(storeImport).not.toBeNull();
    const taken = storeImport![1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();
    expect(taken).toEqual(["loadConfig", "mcpConfigPath"]);
    expect(source).not.toContain("syncMcpConfigs");
    expect(source).not.toContain("writeMcpConfig");
    // Ruling 5, held as a source assertion for the same reason: the behavioural
    // one above is easy to hold today and easy to lose the first time somebody
    // wants an attended session recorded.
    expect(source).not.toContain("appendRun");
    expect(source).not.toContain("appendDiagnosis");
    expect(source).not.toContain("run/log.ts");
  });
});

describe("as: the spawn", () => {
  it("125-S16: all three streams are inherited, nothing is detached, and no timer or stop is registered", async () => {
    const options: Record<string, unknown>[] = [];
    const child = {
      on: (event: string, handler: (code: unknown, signal: unknown) => void) => {
        // Both arguments, as Node's own `close` carries them: a code and a null
        // signal is an ordinary exit, and the two are not interchangeable.
        if (event === "close") setTimeout(() => handler(0, null), 0);
        return child;
      },
    };
    const timers: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      // The `close` hop above is this test's own, not the code's; anything with
      // a real delay would be a wall clock the command must not have.
      if ((ms ?? 0) > 0) timers.push(ms);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    const listenersBefore = process.listenerCount("SIGINT");

    try {
      const ending = await runAttached(
        { spawnable: { command: "claude", args: ["--session-id", "x"], env: { PATH: "/usr/bin" } }, cwd },
        {
          spawn: ((command: string, args: string[], opts: Record<string, unknown>) => {
            void command;
            void args;
            options.push(opts);
            return child;
          }) as unknown as ExecuteDeps["spawn"],
          isWindows: false,
          releaseInput: () => {},
        },
      );
      expect(ending).toEqual({ exitCode: 0, signal: null, spawnProblem: null });
    } finally {
      spy.mockRestore();
    }

    expect(options).toHaveLength(1);
    expect(options[0].stdio).toBe("inherit");
    expect(options[0].detached).toBe(false);
    expect(timers).toEqual([]);
    // 125-S17: with the child in this process's foreground group Ctrl-C reaches
    // both, and Claude Code owns what its own interrupt means.
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
  });

  it("125-S17: a complete invocation installs no SIGINT handler", async () => {
    const before = process.listenerCount("SIGINT");
    const { deps, context } = harness();
    expect(await runAs(deps, context)).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("125-S18: a spawn that fails is one sentence naming the harness and exit 1, never a throw", async () => {
    const { deps, context, captured } = harness({
      startSession: () => Promise.resolve({ exitCode: null, signal: null, spawnProblem: "spawn claude ENOENT" }),
    });
    expect(await runAs(deps, context)).toBe(1);
    expect(captured.errors).toHaveLength(1);
    expect(captured.errors[0]).toContain("claude");
    expect(captured.errors[0]).toContain("PATH");
  });

  it("125-S18: the child's exit code is the command's", async () => {
    for (const code of [0, 1, 2, 130]) {
      const { deps, context } = harness({
        startSession: () => Promise.resolve({ exitCode: code, signal: null, spawnProblem: null }),
      });
      expect(await runAs(deps, context)).toBe(code);
    }
  });

  it("125-S18: a child ended by a signal is a failure and names the signal, not a clean exit", async () => {
    // A killed harness has no exit code at all. Answering 0 for it would tell a
    // wrapper that a session which was killed finished cleanly.
    const { deps, context, captured } = harness({
      startSession: () => Promise.resolve({ exitCode: null, signal: "SIGKILL", spawnProblem: null }),
    });
    expect(await runAs(deps, context)).toBe(1);
    expect(captured.errors[0]).toContain("SIGKILL");
  });

  it("125-S18: runAttached answers rather than throwing when spawn itself throws", async () => {
    const ending = await runAttached(
      { spawnable: { command: "claude", args: [], env: {} }, cwd },
      {
        spawn: (() => {
          throw new Error("EACCES");
        }) as unknown as ExecuteDeps["spawn"],
        isWindows: false,
        releaseInput: () => {},
      },
    );
    expect(ending).toEqual({ exitCode: null, signal: null, spawnProblem: "EACCES" });
  });
});

describe("as: what is on screen", () => {
  it("125-S19: nothing is printed before the harness takes the terminal", async () => {
    const { deps, context, captured } = harness();
    expect(await runAs(deps, context)).toBe(0);
    expect(captured.lines).toEqual([]);
    expect(captured.errors).toEqual([]);
  });

  it("125-S19: no line about permission prompts or what run would have refused", async () => {
    const { deps, context, captured } = harness();
    await runAs(deps, context);
    const said = [...captured.lines, ...captured.errors].join("\n");
    expect(said).not.toMatch(/permission|approv|prompt|refus/i);
  });
});

describe("as: the registry", () => {
  it("125-S2: the command is registered, so --help documents it", () => {
    const registered = COMMANDS.find((c) => c.name === "as");
    expect(registered).toBeDefined();
    expect(registered!.usage).toBe("[agent]");
    expect(registered!.summary).toBe("start a session as one configured agent");
    // It declares no flags of its own.
    expect(registered!.flags ?? []).toEqual([]);
  });
});

describe("as: which agent was meant", () => {
  const configured = ["code-companion-bot", "code-review-bot", "docs-bot"];

  it("125-S31: a prefix that picks out one name is that name", () => {
    expect(resolveAgent("docs", configured)).toEqual({ kind: "one", name: "docs-bot" });
    expect(resolveAgent("code-r", configured)).toEqual({ kind: "one", name: "code-review-bot" });
  });

  it("125-S31: an exact name wins over every prefix it is the start of", () => {
    // Without this the shorter name is the one name on the machine that cannot
    // be asked for.
    expect(resolveAgent("code", ["code", "code-review-bot"])).toEqual({ kind: "one", name: "code" });
  });

  it("125-S31: matching folds case, and an exact match still wins inside the fold", () => {
    expect(resolveAgent("DOCS-BOT", configured)).toEqual({ kind: "one", name: "docs-bot" });
    expect(resolveAgent("Code-R", configured)).toEqual({ kind: "one", name: "code-review-bot" });
    expect(resolveAgent("Docs", ["Docs", "docs-bot"])).toEqual({ kind: "one", name: "Docs" });
    // Two names that fold together are ambiguous, unless one of them is what was typed.
    expect(resolveAgent("Docs", ["Docs", "docs"])).toEqual({ kind: "one", name: "Docs" });
    expect(resolveAgent("DOCS", ["Docs", "docs"])).toEqual({ kind: "many", matches: ["Docs", "docs"] });
    // A name that folds to exactly one configured name beats the prefixes it is
    // the start of, which is the exact rule above read through the fold. Without
    // it, `docs` beside `docs-bot` makes the shorter one askable in its own
    // capitals and ambiguous in any others.
    expect(resolveAgent("DOCS", ["docs", "docs-bot"])).toEqual({ kind: "one", name: "docs" });
  });

  it("125-S31: a prefix that picks out several answers with all of them, in configured order", () => {
    expect(resolveAgent("code-", configured)).toEqual({ kind: "many", matches: ["code-companion-bot", "code-review-bot"] });
    expect(resolveAgent("", configured)).toEqual({ kind: "many", matches: configured });
  });

  it("125-S31: a prefix that picks out nothing is none, and so is a name matched anywhere but the start", () => {
    expect(resolveAgent("nobody", configured)).toEqual({ kind: "none" });
    // Matching inside a name would make the set of matches something to reason
    // about rather than read, and a wrong guess starts a session as the wrong bot.
    expect(resolveAgent("review", configured)).toEqual({ kind: "none" });
  });

  it("125-S31: the heading says what was matched, and asks plainly when nothing was typed", () => {
    expect(pickerHeading("code-", ["code-companion-bot", "code-review-bot"])).toContain("2 agents here start with code-");
    expect(pickerHeading(null, configured)).toBe("Which agent should this session be?");
    expect(pickerHeading("", configured)).toBe("Which agent should this session be?");
  });
});

describe("as: a prefix, and the list when a prefix is not enough", () => {
  const several = () =>
    config({ "code-companion-bot": entry(), "code-review-bot": entry({ id: "agent-2" }), "docs-bot": entry({ id: "agent-3" }) });

  it("125-S32: a prefix that names one agent starts it, and asks nothing", async () => {
    const { deps, context, captured } = harness({ loadConfiguration: () => Promise.resolve({ kind: "config", config: several() }) });
    context.positional = ["code-r"];
    expect(await runAs(deps, context)).toBe(0);
    expect(captured.asked).toEqual([]);
    expect(captured.started).toHaveLength(1);
    // The resolved name is what the session is given rather than the prefix: the
    // per-agent file and the stored key are both keyed by it.
    expect(captured.started[0].args).toContain(mcpConfigPath("code-review-bot"));
  });

  it("125-S33: a prefix naming several, at a terminal, asks with exactly those and starts the answer", async () => {
    const { deps, context, captured } = harness({
      loadConfiguration: () => Promise.resolve({ kind: "config", config: several() }),
      isTTY: true,
      pickAgent: (options, typed) => {
        captured.asked.push({ options, typed });
        return Promise.resolve("code-review-bot");
      },
    });
    context.positional = ["code-"];
    expect(await runAs(deps, context)).toBe(0);
    expect(captured.asked).toEqual([{ options: ["code-companion-bot", "code-review-bot"], typed: "code-" }]);
    expect(captured.errors).toEqual([]);
    expect(captured.started).toHaveLength(1);
    expect(captured.started[0].args).toContain(mcpConfigPath("code-review-bot"));
  });

  it("125-S34: the same prefix with nobody at the terminal names the matches and starts nothing", async () => {
    const { deps, context, captured } = harness({ loadConfiguration: () => Promise.resolve({ kind: "config", config: several() }) });
    context.positional = ["code-"];
    expect(await runAs(deps, context)).toBe(1);
    expect(captured.errors).toEqual([ambiguousAgentMessage("code-", ["code-companion-bot", "code-review-bot"])]);
    expect(captured.errors[0]).toContain("code-companion-bot");
    expect(captured.errors[0]).toContain("code-review-bot");
    expect(captured.asked).toEqual([]);
    expect(captured.started).toEqual([]);
  });

  it("125-S35: no name at a terminal asks over every configured agent", async () => {
    const { deps, context, captured } = harness({
      loadConfiguration: () => Promise.resolve({ kind: "config", config: several() }),
      isTTY: true,
      pickAgent: (options, typed) => {
        captured.asked.push({ options, typed });
        return Promise.resolve("docs-bot");
      },
    });
    context.positional = [];
    expect(await runAs(deps, context)).toBe(0);
    expect(captured.asked).toEqual([{ options: ["code-companion-bot", "code-review-bot", "docs-bot"], typed: null }]);
    expect(captured.started).toHaveLength(1);
  });

  it("125-S36: a machine holding one agent still asks when no name was typed", async () => {
    const { deps, context, captured } = harness({
      isTTY: true,
      pickAgent: (options, typed) => {
        captured.asked.push({ options, typed });
        return Promise.resolve("dev-bot-mdden");
      },
    });
    context.positional = [];
    expect(await runAs(deps, context)).toBe(0);
    // Resolving it would start a real session on a real checkout with nothing asked.
    expect(captured.asked).toEqual([{ options: ["dev-bot-mdden"], typed: null }]);
  });

  it("125-S36: an empty name is a name that was not typed, terminal or not", async () => {
    // `mdbrain as "$AGENT"` with the variable unset. An empty string is a prefix
    // of every name, so on this machine it would otherwise pick out the one agent
    // and start a session nobody named.
    const atTerminal = harness({
      isTTY: true,
      pickAgent(options, typed) {
        atTerminal.captured.asked.push({ options, typed });
        return Promise.resolve("dev-bot-mdden");
      },
    });
    atTerminal.context.positional = [""];
    expect(await runAs(atTerminal.deps, atTerminal.context)).toBe(0);
    expect(atTerminal.captured.asked).toEqual([{ options: ["dev-bot-mdden"], typed: null }]);

    const scripted = harness();
    scripted.context.positional = [""];
    expect(await runAs(scripted.deps, scripted.context)).toBe(1);
    expect(scripted.captured.errors).toEqual([USAGE_MESSAGE]);
    expect(scripted.captured.started).toEqual([]);
  });

  it("125-S36: an empty name with several agents is the usage sentence, not an ambiguity", async () => {
    // The other half of the same collapse: the ambiguity sentence would have
    // named no name, because there was none to name.
    const { deps, context, captured } = harness({ loadConfiguration: () => Promise.resolve({ kind: "config", config: several() }) });
    context.positional = [""];
    expect(await runAs(deps, context)).toBe(1);
    expect(captured.errors).toEqual([USAGE_MESSAGE]);
    expect(captured.asked).toEqual([]);
    expect(captured.started).toEqual([]);
  });

  it("125-S37: leaving the list starts nothing, says nothing, and exits 1", async () => {
    const { deps, context, captured } = harness({ isTTY: true });
    context.positional = [];
    expect(await runAs(deps, context)).toBe(1);
    expect(captured.asked).toHaveLength(1);
    expect(captured.started).toEqual([]);
    expect(captured.errors).toEqual([]);
  });

  it("125-S38: a name that matches nothing is refused rather than asked about, terminal or not", async () => {
    for (const isTTY of [false, true]) {
      const { deps, context, captured } = harness({ loadConfiguration: () => Promise.resolve({ kind: "config", config: several() }), isTTY });
      context.positional = ["nobody"];
      expect(await runAs(deps, context)).toBe(1);
      expect(captured.errors[0]).toBe(unknownAgentMessage("nobody", ["code-companion-bot", "code-review-bot", "docs-bot"]));
      expect(captured.asked).toEqual([]);
      expect(captured.started).toEqual([]);
    }
  });

  it("125-S39: neither the prefix nor the list reaches the key store", async () => {
    const opened = vi.fn();
    const { deps, context } = harness({
      loadConfiguration: () => Promise.resolve({ kind: "config", config: several() }),
      openKeyStore: () => {
        opened();
        return Promise.reject(new Error("not reached"));
      },
    });
    context.positional = ["code-"];
    expect(await runAs(deps, context)).toBe(1);
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("as: the list on screen", () => {
  const tick = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
  };
  const DOWN = "[B";

  it("125-S33: the list draws the matches under a heading that says what matched", async () => {
    const { lastFrame } = renderInk(agentPicker(["code-companion-bot", "code-review-bot"], "code-", () => {}));
    await tick();
    expect(lastFrame()).toContain("mdbrain as");
    expect(lastFrame()).toContain("2 agents here start with code-");
    expect(lastFrame()).toContain("code-companion-bot");
    expect(lastFrame()).toContain("code-review-bot");
  });

  it("125-S33: an arrow and Enter answer with the row that was on", async () => {
    let picked: string | null = null;
    const { stdin } = renderInk(agentPicker(["code-companion-bot", "code-review-bot"], "code-", (name) => { picked = name; }));
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write("\r");
    await tick();
    expect(picked).toBe("code-review-bot");
  });

  it("125-S35: with nothing typed it asks which agent, over everything it was given", async () => {
    const { lastFrame } = renderInk(agentPicker(["code-companion-bot", "docs-bot"], null, () => {}));
    await tick();
    expect(lastFrame()).toContain("Which agent should this session be?");
    expect(lastFrame()).toContain("docs-bot");
  });
});

describe("as: the terminal is handed over, not shared", () => {
  const fakeStdin = (over: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const stdin = {
      isTTY: true,
      setRawMode(value: boolean) {
        calls.push(`setRawMode(${value})`);
      },
      pause() {
        calls.push("pause");
      },
      ...over,
    } as unknown as NodeJS.ReadStream;
    return { stdin, calls };
  };

  it("125-S40: runAttached gives the input back before it spawns, not after", async () => {
    const order: string[] = [];
    const child = { on: () => child } as unknown as ReturnType<ExecuteDeps["spawn"]>;
    await Promise.race([
      runAttached(
        { spawnable: { command: "claude", args: [], env: {} }, cwd },
        {
          spawn: (() => {
            order.push("spawn");
            return child;
          }) as unknown as ExecuteDeps["spawn"],
          isWindows: false,
          releaseInput: () => order.push("release"),
        },
      ),
      // The child never closes here, so the promise never settles: what is being
      // asserted has all happened by the time the spawn returns.
      new Promise((r) => setTimeout(r, 0)),
    ]);
    expect(order).toEqual(["release", "spawn"]);
  });

  it("125-S40: the input is given back even when the spawn then fails", async () => {
    const order: string[] = [];
    const ending = await runAttached(
      { spawnable: { command: "claude", args: [], env: {} }, cwd },
      {
        spawn: (() => {
          order.push("spawn");
          throw new Error("EACCES");
        }) as unknown as ExecuteDeps["spawn"],
        isWindows: false,
        releaseInput: () => order.push("release"),
      },
    );
    expect(order).toEqual(["release", "spawn"]);
    expect(ending.spawnProblem).toBe("EACCES");
  });

  it("125-S41: releasing a terminal turns raw mode off and stops this process reading it", () => {
    const { stdin, calls } = fakeStdin();
    releaseTerminalInput(stdin);
    // The pause is the half that matters: raw mode off with the read still
    // running is still two readers for one keyboard.
    expect(calls).toEqual(["setRawMode(false)", "pause"]);
  });

  it("125-S41: a stdin that is not a terminal has no raw mode to reset, and is still paused", () => {
    const { stdin, calls } = fakeStdin({ isTTY: false });
    releaseTerminalInput(stdin);
    expect(calls).toEqual(["pause"]);
  });

  it("125-S41: a refused raw-mode change does not stop the read being stopped", () => {
    const calls: string[] = [];
    const stdin = {
      isTTY: true,
      setRawMode() {
        throw new Error("ENOTTY");
      },
      pause() {
        calls.push("pause");
      },
    } as unknown as NodeJS.ReadStream;
    expect(() => releaseTerminalInput(stdin)).not.toThrow();
    expect(calls).toEqual(["pause"]);
  });
});
