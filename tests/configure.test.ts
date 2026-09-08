import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import {
  agentChoices,
  agentDefaults,
  assembleConfig,
  completePath,
  connectionKeyVariableFor,
  DRAFT_VERSION,
  judgeCeiling,
  judgeCwd,
  judgeDuration,
  judgePoll,
  judgeSelection,
  judgeVariable,
  mcpFileNameFor,
  organizationsWithoutAgents,
  ownedOrganizations,
  parseDraft,
  rosterAgents,
  summaryLines,
  withheldAgentsLine,
  type Answers,
  type ConfigureDraft,
  type RosterAgent,
} from "../src/configure/questions.ts";
import { configureScreen, type ScreenPlan } from "../src/configure/screen.ts";
import { configure, noTerminalMessage, NOTHING_TO_CONFIGURE, runConfigure, type ConfigureDeps } from "../src/commands/configure.ts";
import { login } from "../src/commands/login.ts";
import { parseConfig, serializeConfig, type Config } from "../src/config/schema.ts";
import { configPath } from "../src/config/paths.ts";
import { draftPath, mcpConfigPath } from "../src/config/store.ts";
import type { ConnectionKeyStore } from "../src/config/secrets.ts";
import { dispatch, parseArgv } from "../src/cli.ts";
import type { CommandContext } from "../src/cli.ts";

const cwd = process.platform === "win32" ? "C:\\work\\checkout" : "/work/checkout";

const roster: RosterAgent[] = [
  { id: "a-1", name: "dev-bot-mdden", organization: "markdownbrain.ai", status: "active" },
  { id: "a-2", name: "spec-warden", organization: "markdownbrain.ai", status: "active" },
  { id: "a-3", name: "old-bot", organization: "markdownbrain.ai", status: "disabled" },
];

const existing = (): Config => ({
  version: 1,
  poll: "5m",
  sessionsPerHour: null,
  agents: {
    "dev-bot-mdden": {
      id: "a-1",
      harness: "claude",
      cwd,
      env: { harness: "ANTHROPIC_API_KEY", connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" },
      bounds: { maxTurns: 40, maxBudgetUsd: 3, wallClock: "20m" },
    },
  },
});

const answersFor = (names: Array<[string, string]>): Answers => ({
  agents: names.map(([name, id]) => ({
    name,
    id,
    cwd,
    harnessVariable: "ANTHROPIC_API_KEY",
    connectionKeyVariable: connectionKeyVariableFor(name),
    bounds: { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" },
  })),
  sessionsPerHour: null,
  poll: "5m",
  dropped: [],
});

/** A key store in memory, so a test can watch what was asked for and what was kept. */
function memoryKeyStore(seed: Record<string, string> = {}): ConnectionKeyStore & { held: Map<string, string> } {
  const held = new Map(Object.entries(seed));
  return {
    held,
    backend: { kind: "file", where: "/tmp/secrets.json", reason: "this runtime has no keychain to put it in" },
    async get(id) {
      return held.get(id) ?? null;
    },
    async set(id, key) {
      held.set(id, key);
    },
    async forget(id) {
      held.delete(id);
    },
  };
}

describe("the roster as the screen offers it", () => {
  const organizations = [{ id: "o-1", name: "markdownbrain.ai" }, { id: "o-2", name: "empty org" }];
  const agents = [
    { id: "a-1", org_id: "o-1", display_name: "dev-bot-mdden", status: "active" },
    { id: "a-3", org_id: "o-1", display_name: "old-bot", status: "disabled" },
    { id: "a-9", org_id: "o-x", display_name: "orphan", status: "active" },
  ];

  it("105-S10: every offered agent under its organization, an inactive one with its status, an organization with none named as such", () => {
    const { options } = agentChoices(rosterAgents(organizations, agents), null);
    expect(options.map((o) => o.label)).toEqual([
      "markdownbrain.ai / dev-bot-mdden",
      "markdownbrain.ai / old-bot (disabled)",
    ]);
    expect(organizationsWithoutAgents(organizations, agents)).toEqual(["empty org"]);
  });

  it("105-S42: the list is ordered by organization, then by name, with digits compared as numbers", () => {
    const orgs = [{ id: "o-b", name: "zeta org" }, { id: "o-a", name: "alpha org" }];
    const unordered = [
      { id: "1", org_id: "o-b", display_name: "bot-10", status: "active" },
      { id: "2", org_id: "o-a", display_name: "Yak", status: "active" },
      { id: "3", org_id: "o-b", display_name: "bot-2", status: "active" },
      { id: "4", org_id: "o-a", display_name: "ant", status: "active" },
    ];
    expect(rosterAgents(orgs, unordered).map((a) => `${a.organization}/${a.name}`)).toEqual([
      "alpha org/ant",
      "alpha org/Yak",
      "zeta org/bot-2",
      "zeta org/bot-10",
    ]);
  });

  it("105-S43: only agents in an organization this account owns are offered, and the rest are counted rather than dropped in silence", () => {
    const orgs = [{ id: "o-mine", name: "mine" }, { id: "o-theirs", name: "theirs" }];
    const memberships = [{ org_id: "o-mine", role: "owner" }, { org_id: "o-theirs", role: "member" }];
    const owned = ownedOrganizations(orgs, memberships);
    expect(owned.map((o) => o.id)).toEqual(["o-mine"]);

    const all = [
      { id: "m-1", org_id: "o-mine", display_name: "mine-bot", status: "active" },
      { id: "t-1", org_id: "o-theirs", display_name: "their-bot", status: "active" },
      { id: "t-2", org_id: "o-theirs", display_name: "their-other-bot", status: "active" },
    ];
    const offered = rosterAgents(owned, all);
    expect(offered.map((a) => a.name)).toEqual(["mine-bot"]);
    expect(organizationsWithoutAgents(owned, all)).toEqual([]);
    expect(withheldAgentsLine(all.length, offered.length)).toMatch(/^2 more agents are not offered/);
    expect(withheldAgentsLine(2, 1)).toMatch(/^One more agent is not offered/);
    expect(withheldAgentsLine(1, 1)).toBeNull();
  });

  it("pre-selects what is configured already", () => {
    const { preselected, disappeared, renamed } = agentChoices(roster, existing());
    expect(preselected).toEqual(["a-1"]);
    expect(disappeared).toEqual([]);
    expect(renamed).toEqual([]);
  });

  it("105-S15: a configured entry the roster no longer holds is offered, marked, and labelled as gone", () => {
    const config = existing();
    config.agents["vanished-bot"] = { ...config.agents["dev-bot-mdden"], id: "a-gone" };
    const { options, preselected, disappeared } = agentChoices(roster, config);
    expect(disappeared).toEqual([{ name: "vanished-bot", id: "a-gone", reason: "no longer in the roster" }]);
    expect(preselected).toContain("a-gone");
    const gone = options.find((o) => o.value === "a-gone");
    expect(gone?.label).toBe("vanished-bot — no longer in the roster");
    expect(gone?.name).toBe("vanished-bot");
  });

  it("105-S43: an entry whose organization this account no longer owns is marked as that, not as deleted", () => {
    const config = existing();
    config.agents["theirs-now"] = { ...config.agents["dev-bot-mdden"], id: "a-theirs" };
    // The agent is still visible to the account; what it lost is the right to
    // manage it, and saying it had been deleted would be a different fact.
    const { options, disappeared } = agentChoices(roster, config, new Set(["a-theirs"]));
    expect(disappeared).toContainEqual({ name: "theirs-now", id: "a-theirs", reason: "no longer an agent you manage" });
    expect(options.find((o) => o.value === "a-theirs")?.label).toBe("theirs-now — no longer an agent you manage");

    const summary = summaryLines(
      assembleConfig(answersFor([["theirs-now", "a-theirs"]])),
      { path: "/c/config.json", mcpPaths: {}, removed: [] },
      [{ name: "theirs-now", id: "a-theirs", reason: "no longer an agent you manage" }],
      [],
    );
    expect(summary.some((l) => l.includes("theirs-now is no longer an agent you manage"))).toBe(true);
  });

  it("105-S16: a configured entry whose id the roster holds under another name is offered as a rename", () => {
    const config = existing();
    config.agents["dev-bot"] = config.agents["dev-bot-mdden"];
    delete config.agents["dev-bot-mdden"];
    const { renamed } = agentChoices(roster, config);
    expect(renamed).toEqual([{ from: "dev-bot", to: "dev-bot-mdden", id: "a-1" }]);
  });

  it("two marked agents with one name are refused before either is asked about, since the file is keyed by name", () => {
    const twoOrgs: RosterAgent[] = [
      { id: "a-1", name: "dev-bot", organization: "org one", status: "active" },
      { id: "b-1", name: "dev-bot", organization: "org two", status: "active" },
    ];
    const { options } = agentChoices(twoOrgs, null);
    const judged = judgeSelection(["a-1", "b-1"], options);
    expect(judged.ok).toBe(false);
    expect(!judged.ok && judged.problem).toMatch(/both called dev-bot/);
    expect(judgeSelection(["a-1"], options)).toEqual({ ok: true, value: ["a-1"] });
    expect(judgeSelection([], options).ok).toBe(false);
  });

  it("105-S53: two names that fold to one connection-key variable are refused, since one agent would run as the other", () => {
    // Two different MCP files, both saying `Bearer ${MDBRAIN_KEY_BOT_ONE}`: the
    // variable folds harder than the file name does, and nothing downstream
    // would catch it now that the variable is derived rather than asked.
    const folding: RosterAgent[] = [
      { id: "a-1", name: "bot.one", organization: "org", status: "active" },
      { id: "a-2", name: "bot-one", organization: "org", status: "active" },
    ];
    expect(mcpFileNameFor("bot.one")).not.toBe(mcpFileNameFor("bot-one"));
    expect(connectionKeyVariableFor("bot.one")).toBe(connectionKeyVariableFor("bot-one"));
    const judged = judgeSelection(["a-1", "a-2"], agentChoices(folding, null).options);
    expect(judged.ok).toBe(false);
    expect(!judged.ok && judged.problem).toMatch(/would both take their connection key from MDBRAIN_KEY_BOT_ONE/);
  });

  it("two names that fold to one connection file are refused as a pair", () => {
    const folding: RosterAgent[] = [
      { id: "a-1", name: "spec warden", organization: "org", status: "active" },
      { id: "a-2", name: "Spec_Warden", organization: "org", status: "active" },
    ];
    expect(mcpFileNameFor("spec warden")).toBe(mcpFileNameFor("Spec_Warden"));
    const judged = judgeSelection(["a-1", "a-2"], agentChoices(folding, null).options);
    expect(judged.ok).toBe(false);
    expect(!judged.ok && judged.problem).toMatch(/share one connection file/);
  });
});

describe("the defaults and the judgements", () => {
  it("105-S11: no harness is asked — the one harness is written", () => {
    const config = assembleConfig(answersFor([["dev-bot-mdden", "a-1"]]));
    expect(config.agents["dev-bot-mdden"].harness).toBe("claude");
  });

  it("offers the existing values on a re-run and the defaults on a first run", () => {
    expect(agentDefaults("dev-bot-mdden", existing().agents["dev-bot-mdden"], "/elsewhere")).toEqual({
      cwd,
      harnessVariable: "ANTHROPIC_API_KEY",
      connectionKeyVariable: "MDBRAIN_KEY_DEV_BOT_MDDEN",
      bounds: { maxTurns: 40, maxBudgetUsd: 3, wallClock: "20m" },
    });
    expect(agentDefaults("spec-warden", null, "/elsewhere").cwd).toBe("/elsewhere");
    expect(connectionKeyVariableFor("spec-warden")).toBe("MDBRAIN_KEY_SPEC_WARDEN");
    expect(connectionKeyVariableFor("  weird--name!")).toBe("MDBRAIN_KEY_WEIRD_NAME");
  });

  it("105-S44: an entry that names no harness variable keeps the machine's own account, and a draft's answer beats the config's", () => {
    const account = existing().agents["dev-bot-mdden"];
    account.env = { ...account.env, harness: null };
    expect(agentDefaults("dev-bot-mdden", account, "/elsewhere").harnessVariable).toBeNull();

    // A draft that has reached the choice and says "the account" must not be read
    // as "not answered yet" and fall back to the variable.
    const withDraft = agentDefaults("dev-bot-mdden", existing().agents["dev-bot-mdden"], "/elsewhere", {
      id: "a-1",
      cwd: "/from-draft",
      harnessVariable: null,
    });
    expect(withDraft.harnessVariable).toBeNull();
    expect(withDraft.cwd).toBe("/from-draft");

    // And a draft that has not reached it leaves the config's answer standing.
    const partial = agentDefaults("dev-bot-mdden", existing().agents["dev-bot-mdden"], "/elsewhere", { id: "a-1", cwd: "/from-draft" });
    expect(partial.harnessVariable).toBe("ANTHROPIC_API_KEY");
  });

  it("105-S12: a cwd that does not exist is refused, one that does is accepted, and a relative one is taken from where configure ran", () => {
    const exists = new Set([cwd, join(cwd, "sub")]);
    expect(judgeCwd("/nowhere", cwd, (p) => exists.has(p))).toEqual({ ok: false, problem: "/nowhere is not a directory that exists." });
    expect(judgeCwd(cwd, cwd, (p) => exists.has(p))).toEqual({ ok: true, value: cwd });
    expect(judgeCwd("sub", cwd, (p) => exists.has(p))).toEqual({ ok: true, value: join(cwd, "sub") });
    expect(judgeCwd("   ", cwd, (p) => exists.has(p)).ok).toBe(false);
  });

  it("105-S13: a credential variable not set in this shell is warned about, not refused", () => {
    const judged = judgeVariable("MDBRAIN_KEY_X", {}, "connection key");
    expect(judged.ok).toBe(true);
    expect(judged.ok && judged.warning).toMatch(/not set in this shell/);
    const set = judgeVariable("MDBRAIN_KEY_X", { MDBRAIN_KEY_X: "smd_agent_1" }, "connection key");
    expect(set).toEqual({ ok: true, value: "MDBRAIN_KEY_X" });
  });

  it("105-S2: a key pasted where a variable's name belongs is refused and told where the key goes", () => {
    const judged = judgeVariable("smd_agent_abc", {}, "connection key");
    expect(judged.ok).toBe(false);
    expect(!judged.ok && judged.problem).toMatch(/Put it in an environment variable/);
    expect(judgeVariable("not a name", {}, "credential").ok).toBe(false);
  });

  it("105-S14: a ceiling above the server's is refused with the reason, and blank keeps the server's", () => {
    expect(judgeCeiling("")).toEqual({ ok: true, value: null });
    expect(judgeCeiling("4")).toEqual({ ok: true, value: 4 });
    const above = judgeCeiling("11");
    expect(above.ok).toBe(false);
    expect(!above.ok && above.problem).toMatch(/cannot be raised/);
    expect(judgeCeiling("0").ok).toBe(false);
  });

  it("durations need a unit, and the poll has a floor", () => {
    expect(judgeDuration("30m")).toEqual({ ok: true, value: "30m" });
    expect(judgeDuration("30").ok).toBe(false);
    expect(judgePoll("10s").ok).toBe(false);
    expect(judgePoll("5m")).toEqual({ ok: true, value: "5m" });
  });

  it("105-S8: every answer the questions accept writes a file parseConfig reads back, for several accepted shapes", () => {
    for (const [ceiling, poll, wall] of [[4, "5m", "30m"], [null, "30s", "2h"], [10, "1h", "500h"]] as const) {
      const answers = answersFor([["dev-bot-mdden", "a-1"], ["spec-warden", "a-2"]]);
      answers.sessionsPerHour = ceiling;
      answers.poll = judgePoll(poll).ok ? poll : "5m";
      for (const a of answers.agents) a.bounds = { ...a.bounds, wallClock: judgeDuration(wall).ok ? wall : "30m" };
      const config = assembleConfig(answers);
      const reading = parseConfig(serializeConfig(config));
      expect(reading.kind === "config" && reading.config, `${ceiling} ${poll} ${wall}`).toEqual(config);
    }
  });

  it("105-S8: an agent on the machine's own account also round-trips, with no harness variable written", () => {
    const answers = answersFor([["dev-bot-mdden", "a-1"]]);
    answers.agents[0].harnessVariable = null;
    const config = assembleConfig(answers);
    const text = serializeConfig(config);
    expect(text).not.toContain("ANTHROPIC_API_KEY");
    const reading = parseConfig(text);
    expect(reading.kind === "config" && reading.config).toEqual(config);
  });

  it("says what happened to each connection key, and names the manual route when one could not be had", () => {
    const answers = answersFor([["dev-bot-mdden", "a-1"], ["spec-warden", "a-2"]]);
    answers.agents[0].harnessVariable = null;
    const config = assembleConfig(answers);
    const lines = summaryLines(config, { path: "/c/config.json", mcpPaths: {}, removed: [] }, [], [], {
      "dev-bot-mdden": { kind: "held" },
      "spec-warden": { kind: "failed", problem: "Only the organization owner can manage agents" },
    });
    expect(lines).toContain("    thinks with this machine's own Claude Code account");
    expect(lines.some((l) => l.includes("already stored on this machine, and kept"))).toBe(true);
    const failed = lines.find((l) => l.includes("no connection key"));
    expect(failed).toMatch(/Only the organization owner can manage agents/);
    expect(failed).toMatch(/MDBRAIN_KEY_SPEC_WARDEN/);
  });

  it("the summary names each agent, its directory, its credentials, the gone ones, the dropped ones and the removed files", () => {
    const config = assembleConfig(answersFor([["dev-bot-mdden", "a-1"]]));
    const lines = summaryLines(
      config,
      { path: "/c/config.json", mcpPaths: { "dev-bot-mdden": "/c/mcp/agent-dev-bot-mdden.json" }, removed: ["/c/mcp/agent-old.json"] },
      [{ name: "dev-bot-mdden", id: "a-1", reason: "no longer in the roster" }],
      [{ from: "helper", to: "helper-bot", id: "a-7" }],
      { "dev-bot-mdden": { kind: "minted" } },
    );
    expect(lines[0]).toBe("Configuration written to /c/config.json.");
    expect(lines).toContain(`    runs in ${cwd}`);
    expect(lines).toContain("    thinks with the key in ANTHROPIC_API_KEY");
    expect(lines.some((l) => l.includes("requested from markdown-den and stored on this machine"))).toBe(true);
    expect(lines.some((l) => l.includes("no longer in the roster"))).toBe(true);
    expect(lines.some((l) => l.includes("helper was dropped"))).toBe(true);
    expect(lines.some((l) => l.includes("removed /c/mcp/agent-old.json"))).toBe(true);
    expect(lines.at(-1)).toMatch(/server's, 10 sessions an hour/);
  });

  it("says nothing about a dropped rename the person then marked anyway, since it is in the file", () => {
    const config = assembleConfig(answersFor([["helper-bot", "a-7"]]));
    const lines = summaryLines(config, { path: "/c/config.json", mcpPaths: {}, removed: [] }, [], [
      { from: "helper", to: "helper-bot", id: "a-7" },
    ]);
    expect(lines.some((l) => l.includes("was dropped"))).toBe(false);
    expect(lines.some((l) => l.includes("helper-bot"))).toBe(true);
  });
});

describe("completing a directory", () => {
  const tree: Record<string, string[]> = {
    [cwd]: ["apps", "apple", "docs"],
    [join(cwd, "apps")]: ["web", "agent-runner"],
  };
  const list = (path: string) => tree[path] ?? [];
  const s = process.platform === "win32" ? "\\" : "/";

  it("105-S45: completes what is being typed, offers every match in order, and walks into a completed directory", () => {
    expect(completePath("ap", cwd, list)).toEqual([`apple${s}`, `apps${s}`]);
    expect(completePath("apps", cwd, list)).toEqual([`apps${s}`]);
    // A separator at the end means the directory is settled and its children are
    // the candidates, rather than its own name being a prefix to match.
    expect(completePath(`apps${s}`, cwd, list)).toEqual([`apps${s}agent-runner${s}`, `apps${s}web${s}`]);
    expect(completePath(`apps${s}w`, cwd, list)).toEqual([`apps${s}web${s}`]);
  });

  it("offers everything for an empty answer, nothing for a directory that is not there, and keeps an absolute answer absolute", () => {
    expect(completePath("", cwd, list)).toEqual([`apple${s}`, `apps${s}`, `docs${s}`]);
    expect(completePath("zzz", cwd, list)).toEqual([]);
    expect(completePath(join(cwd, "ap"), cwd, list)).toEqual([join(cwd, "apple") + s, join(cwd, "apps") + s]);
  });
});

describe("a configure that did not finish", () => {
  it("105-S46: a draft round-trips, and anything else is simply not offered", () => {
    const draft: ConfigureDraft = {
      version: DRAFT_VERSION,
      chosen: ["a-1"],
      dropped: [],
      agents: { "a-1": { id: "a-1", cwd, harnessVariable: null, bounds: { maxTurns: 7, maxBudgetUsd: 2, wallClock: "10m" } } },
      sessionsPerHour: 4,
    };
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);

    expect(parseDraft("{")).toBeNull();
    expect(parseDraft("[]")).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, version: 99 }))).toBeNull();
    // A field of the wrong shape is dropped rather than making the whole draft
    // unusable: a draft is a convenience, and half of one still helps.
    const bent = parseDraft(JSON.stringify({ version: DRAFT_VERSION, chosen: "a-1", agents: { "a-1": { cwd: 7, bounds: "no" } } }));
    expect(bent).toEqual({ version: DRAFT_VERSION, chosen: [], dropped: [], agents: { "a-1": { id: "a-1" } } });
  });
});

describe("the screen", () => {
  const plan = (over: Partial<ScreenPlan> = {}): ScreenPlan => ({
    choices: agentChoices(roster, null),
    emptyOrganizations: [],
    withheld: null,
    existing: null,
    draft: null,
    currentDirectory: cwd,
    env: { ANTHROPIC_API_KEY: "set", MDBRAIN_KEY_DEV_BOT_MDDEN: "set" },
    isDirectory: (p) => p === cwd,
    listDirectory: () => [],
    ...over,
  });

  // Four short turns rather than one longer sleep. A single 30ms wait is enough
  // on an idle machine and not enough inside the full workspace run, where these
  // are the tests that fail first: what has to happen between two keystrokes is
  // several event-loop turns of React and Ink, and yielding four times is a far
  // better proxy for that than sleeping once for the same total.
  const tick = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
  };
  const backspaces = (n: number) => "\u007f".repeat(n);
  const DOWN = "\u001b[B";

  it("draws the roster as an arrow-key list and asks the per-agent questions in order, then the ceiling and the poll", async () => {
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(
      configureScreen(plan({ emptyOrganizations: ["quiet org"], withheld: "One more agent is not offered here." }), (a) => { done = a; }),
    );
    await tick();
    expect(lastFrame()).toContain("Which agents does this machine run?");
    expect(lastFrame()).toContain("markdownbrain.ai / dev-bot-mdden");
    expect(lastFrame()).toContain("old-bot (disabled)");
    expect(lastFrame()).toContain("No agents yet in: quiet org.");
    expect(lastFrame()).toContain("One more agent is not offered here.");
    // Space marks the first row, Enter confirms the selection.
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("dev-bot-mdden (1 of 1)");
    expect(lastFrame()).toContain("Where does dev-bot-mdden run?");
    for (const _question of ["cwd", "pays-for", "variable", "turns", "budget", "wall"]) {
      stdin.write("\r");
      await tick();
    }
    expect(lastFrame()).toContain("Most sessions an hour");
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("How often to ask for work");
    stdin.write("\r");
    await tick();
    expect(done).not.toBeNull();
    const answers = done as unknown as Answers;
    expect(answers.agents.map((a) => a.name)).toEqual(["dev-bot-mdden"]);
    expect(answers.agents[0].cwd).toBe(cwd);
    expect(answers.agents[0].harnessVariable).toBe("ANTHROPIC_API_KEY");
    expect(answers.agents[0].connectionKeyVariable).toBe("MDBRAIN_KEY_DEV_BOT_MDDEN");
    expect(answers.sessionsPerHour).toBeNull();
    expect(answers.poll).toBe("5m");
    expect(answers.dropped).toEqual([]);
  });

  it("never asks for a connection key: it is the server's to mint and this machine's to keep", async () => {
    const { lastFrame, stdin } = render(configureScreen(plan(), () => {}));
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();
    for (let i = 0; i < 8; i += 1) {
      expect(lastFrame()).not.toMatch(/connection key/i);
      stdin.write("\r");
      await tick();
    }
  });

  it("105-S47: choosing the machine's own account skips the variable question and records no variable", async () => {
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(plan(), (a) => { done = a; }));
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("\r"); // cwd
    await tick();
    expect(lastFrame()).toContain("What pays for dev-bot-mdden's thinking?");
    stdin.write(DOWN); // from the variable, offered first because that is the default, to the account
    await tick();
    stdin.write("\r");
    await tick();
    // Straight to the bounds: there is no variable to name.
    expect(lastFrame()).toContain("Most turns a session of dev-bot-mdden may take.");
    for (let i = 0; i < 5; i += 1) {
      stdin.write("\r");
      await tick();
    }
    expect((done as unknown as Answers).agents[0].harnessVariable).toBeNull();
  });

  it("refuses to go on with nobody marked, and shows a refused answer in place", async () => {
    const { lastFrame, stdin } = render(configureScreen(plan(), () => {}));
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Pick at least one agent");
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();
    // The cwd offered is the current directory, which the plan says exists.
    // Backspace through it and type one that does not.
    stdin.write(backspaces(cwd.length));
    await tick();
    for (const c of "/nowhere") stdin.write(c);
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("/nowhere is not a directory that exists.");
  });

  it("105-S48: a refused directory comes back with what was typed, not with the default", async () => {
    const { lastFrame, stdin } = render(configureScreen(plan(), () => {}));
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write(backspaces(cwd.length));
    await tick();
    for (const c of "/almost/right") stdin.write(c);
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("is not a directory that exists.");
    // The whole of the point: a one-character mistake costs one character.
    expect(lastFrame()).toContain("/almost/right");
    expect(lastFrame()).not.toContain(cwd);
  });

  it("105-S45: Tab completes the directory in place, and Tab again offers the next match", async () => {
    const tree: Record<string, string[]> = { [cwd]: ["alpha", "alps"] };
    const { lastFrame, stdin } = render(configureScreen(plan({ listDirectory: (p) => tree[p] ?? [] }), () => {}));
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write(backspaces(cwd.length));
    await tick();
    for (const c of "al") stdin.write(c);
    await tick();
    stdin.write("\t");
    await tick();
    expect(lastFrame()).toContain("alpha");
    stdin.write("\t");
    await tick();
    expect(lastFrame()).toContain("alps");
    expect(lastFrame()).not.toContain("alpha");
  });

  it("105-S49: every answer is recorded as it is given, so quitting part-way loses none of them", async () => {
    const drafts: ConfigureDraft[] = [];
    const { stdin } = render(configureScreen(plan({ record: (d) => drafts.push(d) }), () => {}));
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r"); // the selection
    await tick();
    stdin.write("\r"); // cwd
    await tick();
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    const latest = drafts[drafts.length - 1];
    expect(latest.chosen).toEqual(["a-1"]);
    expect(latest.agents["a-1"].cwd).toBe(cwd);
  });

  it("105-S49: the draft's answers are what the next run offers, ahead of the config's", async () => {
    const config = existing();
    let done: Answers | null = null;
    const draft: ConfigureDraft = {
      version: DRAFT_VERSION,
      chosen: ["a-2"],
      dropped: [],
      agents: { "a-2": { id: "a-2", cwd, harnessVariable: null, bounds: { maxTurns: 9, maxBudgetUsd: 1, wallClock: "9m" } } },
      sessionsPerHour: 3,
    };
    const { lastFrame, stdin } = render(
      configureScreen(plan({ choices: agentChoices(roster, config), existing: config, draft }), (a) => { done = a; }),
    );
    await tick();
    // The draft marked spec-warden, not the config's dev-bot-mdden.
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("spec-warden (1 of 1)");
    // Five per-agent questions rather than six: the draft says the machine's own
    // account, so there is no variable to name.
    for (let i = 0; i < 7; i += 1) {
      stdin.write("\r");
      await tick();
    }
    const answers = done as unknown as Answers;
    expect(answers.agents[0].name).toBe("spec-warden");
    expect(answers.agents[0].harnessVariable).toBeNull();
    expect(answers.agents[0].bounds).toEqual({ maxTurns: 9, maxBudgetUsd: 1, wallClock: "9m" });
    expect(answers.sessionsPerHour).toBe(3);
  });

  it("carries a configured ceiling over on a re-run, so Enter keeps it rather than dropping it", async () => {
    const config = existing();
    config.sessionsPerHour = 4;
    let done: Answers | null = null;
    const { stdin } = render(configureScreen(plan({ choices: agentChoices(roster, config), existing: config }), (a) => { done = a; }));
    await tick();
    stdin.write("\r"); // the pre-selected entry, confirmed as is
    await tick();
    for (let i = 0; i < 6; i++) { stdin.write("\r"); await tick(); }
    stdin.write("\r"); // ceiling: Enter keeps 4
    await tick();
    stdin.write("\r"); // poll
    await tick();
    expect((done as unknown as Answers).sessionsPerHour).toBe(4);
    expect((done as unknown as Answers).agents[0].bounds).toEqual({ maxTurns: 40, maxBudgetUsd: 3, wallClock: "20m" });
  });

  it("105-S16: offers a rename before the list; yes keeps the entry under the new name, no drops it and says so", async () => {
    const config = existing();
    config.agents["dev-bot"] = config.agents["dev-bot-mdden"];
    delete config.agents["dev-bot-mdden"];
    const renamedPlan = plan({ choices: agentChoices(roster, config), existing: config });

    const kept = render(configureScreen(renamedPlan, () => {}));
    await tick();
    expect(kept.lastFrame()).toContain("dev-bot is now called dev-bot-mdden in the roster. Keep the entry under the new name?");
    expect(kept.lastFrame()).toContain("answering no drops it");
    kept.stdin.write("\r");
    await tick();
    expect(kept.lastFrame()).toContain("Which agents does this machine run?");
    kept.stdin.write("\r"); // still marked, so it goes straight to its questions
    await tick();
    expect(kept.lastFrame()).toContain("dev-bot-mdden (1 of 1)");

    let done: Answers | null = null;
    const dropped = render(configureScreen(renamedPlan, (a) => { done = a; }));
    await tick();
    dropped.stdin.write("n");
    await tick();
    expect(dropped.lastFrame()).toContain("Which agents does this machine run?");
    // No longer marked; mark the second agent instead and go through.
    dropped.stdin.write("\u001b[B"); // down
    dropped.stdin.write(" ");
    await tick();
    dropped.stdin.write("\r");
    await tick();
    for (let i = 0; i < 8; i++) { dropped.stdin.write("\r"); await tick(); }
    expect((done as unknown as Answers).dropped).toEqual([{ from: "dev-bot", to: "dev-bot-mdden", id: "a-1" }]);
    expect((done as unknown as Answers).agents.map((a) => a.name)).toEqual(["spec-warden"]);
  });
});

describe("the command", () => {
  let root: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mdbrain-configure-"));
    previous = { config: process.env.MDBRAIN_CONFIG_DIR, state: process.env.MDBRAIN_STATE_DIR };
    process.env.MDBRAIN_CONFIG_DIR = join(root, "config");
    process.env.MDBRAIN_STATE_DIR = join(root, "state");
    mkdirSync(join(root, "state"), { recursive: true });
  });

  afterEach(() => {
    for (const [key, name] of [["config", "MDBRAIN_CONFIG_DIR"], ["state", "MDBRAIN_STATE_DIR"]] as const) {
      if (previous[key] === undefined) delete process.env[name];
      else process.env[name] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    const context: CommandContext = { positional: [], flags: {}, out: (l) => out.push(l), err: (l) => err.push(l) };
    return { out, err, context };
  };

  const validSession = () =>
    writeFileSync(
      join(root, "state", "session.json"),
      JSON.stringify({ accessToken: "at", refreshToken: "rt", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
    );

  /** Every read `configure` makes, answered: the account, its organizations, its agents, its roles. */
  const rosterReply = (url: string) => {
    const body = url.includes("organization_members")
      ? [{ org_id: "o-1", role: "owner" }, { org_id: "o-2", role: "owner" }]
      : url.includes("organizations")
        ? [{ id: "o-1", name: "markdownbrain.ai" }, { id: "o-2", name: "quiet org" }]
        : url.includes("/agents")
          ? [{ id: "a-1", org_id: "o-1", display_name: "dev-bot-mdden", status: "active" }]
          : url.includes("rpc/mint_agent_key")
            ? [{ id: "k-1", key: "smd_agent_abcdef01_minted" }]
            : { email: "diego@example.com", id: "u-1" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  async function withFetch<T>(reply: (url: string) => Response, body: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => Promise.resolve(reply(String(input)))) as typeof fetch;
    try {
      return await body();
    } finally {
      globalThis.fetch = original;
    }
  }

  const deps = (over: Partial<ConfigureDeps> = {}): ConfigureDeps => ({
    isTTY: true,
    ask: async () => answersFor([["dev-bot-mdden", "a-1"]]),
    loginNow: async () => { throw new Error("login should not run"); },
    env: { ANTHROPIC_API_KEY: "x", MDBRAIN_KEY_DEV_BOT_MDDEN: "y" },
    currentDirectory: cwd,
    isDirectory: (p) => p === cwd,
    listDirectory: () => [],
    openKeyStore: async () => memoryKeyStore(),
    ...over,
  });

  it("105-S18: with no terminal it refuses in one sentence naming the file, and exits 1", async () => {
    const { err, context } = io();
    expect(await runConfigure(deps({ isTTY: false }), context)).toBe(1);
    expect(err).toEqual([noTerminalMessage(configPath())]);
    expect(existsSync(configPath())).toBe(false);
  });

  it("105-S1: with a session, writes config.json and the MCP file, leaves the session as it was, and prints the summary", async () => {
    validSession();
    const stateBefore = readFileSync(join(root, "state", "session.json"), "utf8");
    const { out, context } = io();
    const code = await withFetch(rosterReply, () => runConfigure(deps(), context));
    expect(code).toBe(0);
    const written = parseConfig(readFileSync(configPath(), "utf8"));
    expect(written.kind === "config" && Object.keys(written.config.agents)).toEqual(["dev-bot-mdden"]);
    expect(existsSync(mcpConfigPath("dev-bot-mdden"))).toBe(true);
    expect(readFileSync(join(root, "state", "session.json"), "utf8")).toBe(stateBefore);
    expect(out[0]).toBe(`Configuration written to ${configPath()}.`);
    expect(out.at(-1)).toMatch(/Connection keys are held in/);
  });

  it("105-S50: the key is asked of the server and kept on this machine, and never written into the config", async () => {
    validSession();
    const store = memoryKeyStore();
    const { out, context } = io();
    const code = await withFetch(rosterReply, () => runConfigure(deps({ openKeyStore: async () => store }), context));
    expect(code).toBe(0);
    expect(store.held.get("a-1")).toBe("smd_agent_abcdef01_minted");
    const text = readFileSync(configPath(), "utf8");
    expect(text).not.toContain("smd_agent");
    expect(text).toContain("MDBRAIN_KEY_DEV_BOT_MDDEN");
    expect(readFileSync(mcpConfigPath("dev-bot-mdden"), "utf8")).not.toContain("smd_agent");
    expect(out.some((l) => l.includes("requested from markdown-den and stored on this machine"))).toBe(true);
  });

  it("105-S50: a key already on this machine is kept rather than a second one minted", async () => {
    validSession();
    const store = memoryKeyStore({ "a-1": "smd_agent_00000000_already" });
    let mints = 0;
    const { out, context } = io();
    await withFetch(
      (url) => {
        if (url.includes("rpc/mint_agent_key")) mints += 1;
        return rosterReply(url);
      },
      () => runConfigure(deps({ openKeyStore: async () => store }), context),
    );
    expect(mints).toBe(0);
    expect(store.held.get("a-1")).toBe("smd_agent_00000000_already");
    expect(out.some((l) => l.includes("already stored on this machine"))).toBe(true);
  });

  it("105-S50: a refused mint is reported against its agent and the configuration is still written", async () => {
    validSession();
    const { out, context } = io();
    const code = await withFetch(
      (url) =>
        url.includes("rpc/mint_agent_key")
          ? new Response(JSON.stringify({ message: "Only the organization owner can manage agents" }), { status: 403 })
          : rosterReply(url),
      () => runConfigure(deps(), context),
    );
    expect(code).toBe(0);
    expect(existsSync(configPath())).toBe(true);
    expect(out.some((l) => l.includes("no connection key") && l.includes("Only the organization owner"))).toBe(true);
  });

  it("105-S50: --new-keys mints again for an agent this machine already holds a key for", async () => {
    validSession();
    const store = memoryKeyStore({ "a-1": "smd_agent_00000000_revoked" });
    const out: string[] = [];
    const context: CommandContext = { positional: [], flags: { "new-keys": true }, out: (l) => out.push(l), err: () => {} };
    const code = await withFetch(rosterReply, () => runConfigure(deps({ openKeyStore: async () => store }), context));
    expect(code).toBe(0);
    expect(store.held.get("a-1")).toBe("smd_agent_abcdef01_minted");
    expect(out.some((l) => l.includes("a fresh connection key requested"))).toBe(true);
  });

  it("105-S43: an owner whose organizations hold no agent yet is told to create one, not told about ownership", async () => {
    validSession();
    const { err, context } = io();
    const code = await withFetch(
      (url) => (url.includes("/agents") && !url.includes("rpc/") ? new Response("[]", { status: 200 }) : rosterReply(url)),
      () => runConfigure(deps(), context),
    );
    expect(code).toBe(1);
    expect(err[0]).toMatch(/^No agents yet in markdownbrain\.ai, quiet org/);
    expect(err[0]).toMatch(/Create one in markdown-den first/);
    expect(err[0]).not.toMatch(/you own/);
  });

  it("105-S43: an account that owns nothing is told why there is nothing to configure, rather than shown an empty list", async () => {
    validSession();
    const { err, context } = io();
    const code = await withFetch(
      (url) =>
        url.includes("organization_members")
          ? new Response(JSON.stringify([{ org_id: "o-1", role: "member" }]), { status: 200 })
          : rosterReply(url),
      () => runConfigure(deps(), context),
    );
    expect(code).toBe(1);
    expect(err).toEqual([NOTHING_TO_CONFIGURE]);
    expect(existsSync(configPath())).toBe(false);
  });

  it("105-S43: the screen is told how many agents were withheld, so their absence is not silence", async () => {
    validSession();
    let seen: ScreenPlan | null = null;
    const { context } = io();
    await withFetch(
      (url) =>
        url.includes("organization_members")
          ? new Response(JSON.stringify([{ org_id: "o-1", role: "owner" }]), { status: 200 })
          : url.includes("/agents")
            ? new Response(
                JSON.stringify([
                  { id: "a-1", org_id: "o-1", display_name: "dev-bot-mdden", status: "active" },
                  { id: "z-1", org_id: "o-9", display_name: "someone-elses-bot", status: "active" },
                ]),
                { status: 200 },
              )
            : rosterReply(url),
      () => runConfigure(deps({ ask: async (p) => { seen = p; return answersFor([["dev-bot-mdden", "a-1"]]); } }), context),
    );
    const seenPlan = seen as unknown as ScreenPlan;
    expect(seenPlan.choices.options.map((o) => o.name)).toEqual(["dev-bot-mdden"]);
    expect(seenPlan.withheld).toMatch(/One more agent is not offered/);
  });

  it("105-S49: the draft is offered on the way in and forgotten once the file is written", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      draftPath(),
      JSON.stringify({ version: DRAFT_VERSION, chosen: ["a-1"], dropped: [], agents: { "a-1": { id: "a-1", cwd } }, sessionsPerHour: 2 }),
    );
    let seen: ScreenPlan | null = null;
    const { out, context } = io();
    const code = await withFetch(rosterReply, () =>
      runConfigure(deps({ ask: async (p) => { seen = p; return answersFor([["dev-bot-mdden", "a-1"]]); } }), context),
    );
    expect(code).toBe(0);
    expect((seen as unknown as ScreenPlan).draft?.chosen).toEqual(["a-1"]);
    expect(out.some((l) => l.includes("did not finish"))).toBe(true);
    expect(existsSync(draftPath())).toBe(false);
  });

  it("the per-agent files land before the config does, so a failure among them leaves the old config whole", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    const before = serializeConfig(existing());
    writeFileSync(configPath(), before);
    // A regular file where the mcp folder must go makes every per-agent write fail.
    writeFileSync(join(root, "config", "mcp"), "not a folder");
    const { err, context } = io();
    const code = await withFetch(rosterReply, () => runConfigure(deps(), context));
    expect(code).toBe(1);
    expect(err[0]).toMatch(/could not be written/);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("105-S9: signed out, it runs the login and then the questions in the same command; signed in, it does not", async () => {
    let logins = 0;
    const { context } = io();
    const code = await withFetch(rosterReply, () =>
      runConfigure(
        deps({
          loginNow: async () => {
            logins += 1;
            validSession();
            return 0;
          },
        }),
        context,
      ),
    );
    expect(code).toBe(0);
    expect(logins).toBe(1);
    expect(existsSync(configPath())).toBe(true);

    const again = io();
    const second = await withFetch(rosterReply, () => runConfigure(deps(), again.context));
    expect(second).toBe(0);
    expect(logins).toBe(1);
  });

  it("declares the login's flags plus its own, so `--port 8976` reaches the login it runs as a value and not as a bare flag", async () => {
    for (const flag of login.flags ?? []) expect(configure.flags).toContainEqual(flag);
    expect((configure.flags ?? []).map((f) => f.name)).toContain("new-keys");
    const valueFlags = new Set((configure.flags ?? []).filter((f) => f.takesValue).map((f) => f.name));
    expect(parseArgv(["configure", "--port", "8976", "--no-browser"], valueFlags).flags).toEqual({ port: "8976", "no-browser": true });
    // And --help for configure lists them, since the login they reach is this command's own.
    const out: string[] = [];
    await dispatch(["configure", "--help"], [configure], "0.0.0", { out: (l) => out.push(l), err: () => {} });
    expect(out.join("\n")).toContain("--port");
  });

  it("a login that fails ends the command with its own exit code, and writes nothing", async () => {
    const { context } = io();
    const code = await runConfigure(deps({ loginNow: async () => 1 }), context);
    expect(code).toBe(1);
    expect(existsSync(configPath())).toBe(false);
  });

  it("105-S17: leaving the screen writes no config and leaves an existing file untouched — but keeps the draft", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    const before = serializeConfig(existing());
    writeFileSync(configPath(), before);
    writeFileSync(draftPath(), JSON.stringify({ version: DRAFT_VERSION, chosen: ["a-1"], dropped: [], agents: {} }));
    const { err, context } = io();
    const code = await withFetch(rosterReply, () => runConfigure(deps({ ask: async () => null }), context));
    expect(code).toBe(1);
    expect(err).toEqual(["Nothing written."]);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(existsSync(draftPath())).toBe(true);
  });

  it("hands the screen the existing config and the empty organizations, so its entries are pre-selected", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(configPath(), serializeConfig(existing()));
    let seen: ScreenPlan | null = null;
    const { context } = io();
    await withFetch(rosterReply, () =>
      runConfigure(deps({ ask: async (plan) => { seen = plan; return answersFor([["dev-bot-mdden", "a-1"]]); } }), context),
    );
    expect(seen).not.toBeNull();
    expect((seen as unknown as ScreenPlan).choices.preselected).toEqual(["a-1"]);
    expect((seen as unknown as ScreenPlan).emptyOrganizations).toEqual(["quiet org"]);
  });

  it("a session the server refuses on the roster read is reported as a sign-in, not as a roster failure", async () => {
    validSession();
    const { err, context } = io();
    const code = await withFetch(
      () => new Response(JSON.stringify({ message: "invalid JWT" }), { status: 403 }),
      () => runConfigure(deps(), context),
    );
    expect(code).toBe(1);
    expect(err[0]).toMatch(/mdbrain login/);
  });
});
