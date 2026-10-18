import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import {
  agentChoices,
  agentDefaults,
  agentRows,
  agentSummary,
  assembleConfig,
  changesLabel,
  countChanges,
  limitsLabel,
  carriedEntries,
  carriedOver,
  completePath,
  connectionKeyVariableFor,
  DRAFT_VERSION,
  idsToForget,
  judgeBudget,
  judgeCeiling,
  judgeCwd,
  judgeDuration,
  judgeSelection,
  judgeVariable,
  mcpFileNameFor,
  NOTHING_TO_MANAGE,
  organizationsWithoutAgents,
  ownedOrganizations,
  parseDraft,
  pollingChoices,
  rosterAgents,
  summaryLines,
  withheldAgentsLine,
  type Answers,
  type ConfigureDraft,
  type RosterAgent,
} from "../src/configure/questions.ts";
import { configureScreen, type ScreenPlan } from "../src/configure/screen.ts";
import { configure, noTerminalMessage, runConfigure, type ConfigureDeps } from "../src/commands/configure.ts";
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
  sessionsPerHour: null,
  agents: {
    "dev-bot-mdden": {
      id: "a-1",
      harness: "claude",
      pollsWork: true,
      cwd,
      env: { harness: "ANTHROPIC_API_KEY", connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" },
      limits: { maxBudgetUsd: 3, wallClock: "20m" },
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
    limits: {},
    pollsWork: true,
  })),
  sessionsPerHour: null,
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
    { id: "a-1", org_id: "o-1", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-dev-bot" },
    { id: "a-3", org_id: "o-1", display_name: "old-bot", status: "disabled", bot_user_id: "u-old-bot" },
    { id: "a-9", org_id: "o-x", display_name: "orphan", status: "active", bot_user_id: "u-orphan" },
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
      { id: "1", org_id: "o-b", display_name: "bot-10", status: "active", bot_user_id: "u-1" },
      { id: "2", org_id: "o-a", display_name: "Yak", status: "active", bot_user_id: "u-2" },
      { id: "3", org_id: "o-b", display_name: "bot-2", status: "active", bot_user_id: "u-3" },
      { id: "4", org_id: "o-a", display_name: "ant", status: "active", bot_user_id: "u-4" },
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
      { id: "m-1", org_id: "o-mine", display_name: "mine-bot", status: "active", bot_user_id: "u-mine-bot" },
      { id: "t-1", org_id: "o-theirs", display_name: "their-bot", status: "active", bot_user_id: "u-their-bot" },
      { id: "t-2", org_id: "o-theirs", display_name: "their-other-bot", status: "active", bot_user_id: "u-their-other-bot" },
    ];
    const offered = rosterAgents(owned, all);
    expect(offered.map((a) => a.name)).toEqual(["mine-bot"]);
    expect(organizationsWithoutAgents(owned, all)).toEqual([]);
    expect(withheldAgentsLine(all.length - offered.length)).toMatch(/^2 agents are not shown/);
    expect(withheldAgentsLine(1)).toMatch(/^One agent is not shown/);
    expect(withheldAgentsLine(0)).toBeNull();
  });

  it("pre-selects what is configured already", () => {
    const { preselected, disappeared, renamed } = agentChoices(roster, existing());
    expect(preselected).toEqual(["a-1"]);
    expect(disappeared).toEqual([]);
    expect(renamed).toEqual([]);
  });

  it("105-S15: a configured entry the roster no longer holds is offered, unmarked, and labelled as gone", () => {
    const config = existing();
    config.agents["vanished-bot"] = { ...config.agents["dev-bot-mdden"], id: "a-gone" };
    const { options, preselected, disappeared } = agentChoices(roster, config);
    expect(disappeared).toEqual([{ name: "vanished-bot", id: "a-gone", reason: "no longer in the roster" }]);
    // Unmarked since 158-S3: its agent was deleted, and its keys with it.
    expect(preselected).not.toContain("a-gone");
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
      limits: { maxBudgetUsd: 3, wallClock: "20m" },
      pollsWork: true,
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

  it("durations need a unit", () => {
    expect(judgeDuration("30m")).toEqual({ ok: true, value: "30m" });
    expect(judgeDuration("30").ok).toBe(false);
  });

  it("105-S8: every answer the questions accept writes a file parseConfig reads back, for several accepted shapes", () => {
    for (const [ceiling, wall] of [[4, "30m"], [null, "2h"], [10, "500h"]] as const) {
      const answers = answersFor([["dev-bot-mdden", "a-1"], ["spec-warden", "a-2"]]);
      answers.sessionsPerHour = ceiling;
      for (const a of answers.agents) a.limits = judgeDuration(wall).ok ? { wallClock: wall } : {};
      const config = assembleConfig(answers);
      const reading = parseConfig(serializeConfig(config));
      expect(reading.kind === "config" && reading.config, `${ceiling} ${wall}`).toEqual(config);
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

  it("says what happened to each connection key, and names the route that works when one could not be had", () => {
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
    expect(failed).toMatch(/mdbrain configure stores one/);
    // `run` takes the key from this machine's key store and never from the
    // variable, so naming the variable here would be a remedy that cannot work.
    expect(failed).not.toMatch(/MDBRAIN_KEY_SPEC_WARDEN/);
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
    expect(lines.some((l) => l.includes("requested from markdownbrain.ai and stored on this machine"))).toBe(true);
    expect(lines.some((l) => l.includes("no longer in the roster"))).toBe(true);
    expect(lines.some((l) => l.includes("helper was dropped"))).toBe(true);
    expect(lines.some((l) => l.includes("removed /c/mcp/agent-old.json"))).toBe(true);
    expect(lines.at(-1)).toMatch(/server's, 10 sessions an hour/);
  });

  it("121-S4: the closing summary names the ceiling and says nothing about a poll", () => {
    const answers = answersFor([["dev-bot-mdden", "a-1"]]);
    const report = { path: "/c/config.json", mcpPaths: {}, removed: [] };
    // Both branches of the line, since only one of them is drawn at a time and
    // the poll used to be on the end of each.
    const serversOwn = summaryLines(assembleConfig(answers), report, [], [], {});
    expect(serversOwn.at(-1)).toBe(`Ceiling: the server's, 10 sessions an hour per agent.`);

    const chosen = summaryLines(assembleConfig({ ...answers, sessionsPerHour: 4 }), report, [], [], {});
    expect(chosen.at(-1)).toBe("Ceiling: 4 sessions an hour per agent.");

    for (const line of [...serversOwn, ...chosen]) expect(line).not.toMatch(/Poll/i);
  });

  it("125-S23: the work question is offered from the chosen set, marked from the draft, then the config, then everybody", () => {
    const options = agentChoices(roster, null).options;

    const fresh = pollingChoices(["a-1", "a-2"], options, null, null);
    expect(fresh.options.map((o) => o.value)).toEqual(["a-1", "a-2"]);
    expect(fresh.preselected).toEqual(["a-1", "a-2"]);

    const config = existing();
    config.agents["dev-bot-mdden"].pollsWork = false;
    expect(pollingChoices(["a-1", "a-2"], options, config, null).preselected).toEqual(["a-2"]);

    const draft: ConfigureDraft = { version: DRAFT_VERSION, chosen: ["a-1", "a-2"], pollers: ["a-2"], agents: {}, dropped: [] };
    expect(pollingChoices(["a-1", "a-2"], options, null, draft).preselected).toEqual(["a-2"]);

    // An empty answer is an answer: a draft that says nobody must not be read as
    // a draft that never reached the question, which would re-mark everybody.
    const nobody: ConfigureDraft = { ...draft, pollers: [] };
    expect(pollingChoices(["a-1", "a-2"], options, null, nobody).preselected).toEqual([]);

    // But it answers only for the agents it was asked about. An agent marked for
    // the first time this run was never put to the previous one, and taking its
    // absence from `pollers` as a no would write `pollsWork: false` for an agent
    // nobody unmarked.
    const partial: ConfigureDraft = { version: DRAFT_VERSION, chosen: ["a-1"], pollers: [], agents: {}, dropped: [] };
    expect(pollingChoices(["a-1", "a-2"], options, null, partial).preselected).toEqual(["a-2"]);
    const unanswered: ConfigureDraft = { version: DRAFT_VERSION, chosen: ["a-1", "a-2"], agents: {}, dropped: [] };
    expect(pollingChoices(["a-1", "a-2"], options, null, unanswered).preselected).toEqual(["a-1", "a-2"]);

    // Nothing outside the first answer is offered, whatever the roster holds.
    expect(pollingChoices(["a-2"], options, null, null).options.map((o) => o.value)).toEqual(["a-2"]);
  });

  it("125-S25: an identity-only entry is written as one, and the summary says which of the two each agent is", () => {
    const answers = answersFor([["dev-bot-mdden", "a-1"], ["spec-warden", "a-2"]]);
    answers.agents[1].pollsWork = false;
    const config = assembleConfig(answers);
    expect(config.agents["dev-bot-mdden"].pollsWork).toBe(true);
    expect(config.agents["spec-warden"].pollsWork).toBe(false);
    // The identity is written for both: what false withholds is the poll and
    // nothing else.
    expect(config.agents["spec-warden"].cwd).toBe(cwd);
    expect(config.agents["spec-warden"].env.connectionKey).toBe("MDBRAIN_KEY_SPEC_WARDEN");

    const lines = summaryLines(config, { path: "/c/config.json", mcpPaths: {}, removed: [] }, [], []);
    expect(lines).toContain("    asked for work by mdbrain run");
    expect(lines).toContain("    identity only: mdbrain as starts a session as it, and mdbrain run never asks for its work");
    expect(lines.some((l) => l.includes("nobody to ask"))).toBe(false);

    // And when nothing is asked for, the summary says so where it was decided.
    const none = assembleConfig({ ...answers, agents: answers.agents.map((a) => ({ ...a, pollsWork: false })) });
    expect(summaryLines(none, { path: "/c/config.json", mcpPaths: {}, removed: [] }, [], []).at(-1)).toBe(
      "No agent here is asked for work, so mdbrain run has nobody to ask. This machine is configured for mdbrain as.",
    );
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

describe("177: the limit judges", () => {
  it("177-S4: blank and none are answers to the budget and the wall clock, and mean none", () => {
    for (const none of ["", "  ", "none", "None"]) {
      expect(judgeBudget(none)).toEqual({ ok: true, value: null });
      expect(judgeDuration(none)).toEqual({ ok: true, value: null });
    }
    expect(judgeBudget("20")).toEqual({ ok: true, value: 20 });
    expect(judgeBudget("-1").ok).toBe(false);
    expect(judgeDuration("2h")).toEqual({ ok: true, value: "2h" });
    expect(judgeDuration("2").ok).toBe(false);
  });

  it("177: the limits read none, $20, 2h or $20 · 2h, and the menu line says no limits for a poller with none", () => {
    expect(limitsLabel({})).toBe("none");
    expect(limitsLabel({ maxBudgetUsd: 20 })).toBe("$20");
    expect(limitsLabel({ wallClock: "2h" })).toBe("2h");
    expect(limitsLabel({ maxBudgetUsd: 20, wallClock: "2h" })).toBe("$20 · 2h");
    const agent = agentDefaults("dev-bot-mdden", null, cwd);
    expect(agentSummary({ ...agent, limits: {} })).toBe(`polls · ${cwd} · no limits`);
    expect(agentSummary({ ...agent, pollsWork: false })).toBe(`identity only · ${cwd}`);
  });

  it("177: changes are counted by setting, matched by id, with an added or removed agent as one each", () => {
    const before = existing();
    const same = assembleConfig({
      agents: [{ name: "dev-bot-mdden", id: "a-1", cwd, harnessVariable: "ANTHROPIC_API_KEY", connectionKeyVariable: "MDBRAIN_KEY_DEV_BOT_MDDEN", limits: { maxBudgetUsd: 3, wallClock: "20m" }, pollsWork: true }],
      sessionsPerHour: null,
      dropped: [],
    });
    expect(countChanges(before, same)).toBe(0);
    const moved = structuredClone(same);
    moved.agents["dev-bot-mdden"].cwd = "/elsewhere";
    moved.agents["dev-bot-mdden"].limits = {};
    moved.sessionsPerHour = 4;
    expect(countChanges(before, moved)).toBe(3);
    const added = assembleConfig(answersFor([["dev-bot-mdden", "a-1"], ["spec-warden", "a-2"]]));
    // a-1's limits differ from the fixture's, and a-2 is new.
    expect(countChanges(before, added)).toBe(2);
    expect(changesLabel(0)).toBe("no changes");
    expect(changesLabel(1)).toBe("1 change");
    expect(changesLabel(2)).toBe("2 changes");
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
      agents: { "a-1": { id: "a-1", cwd, harnessVariable: null, limits: { maxBudgetUsd: 2, wallClock: "10m" } } },
      sessionsPerHour: 4,
    };
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);

    expect(parseDraft("{")).toBeNull();
    expect(parseDraft("[]")).toBeNull();
    expect(parseDraft(JSON.stringify({ ...draft, version: 99 }))).toBeNull();
    // A field of the wrong shape is dropped rather than making the whole draft
    // unusable: a draft is a convenience, and half of one still helps.
    const bent = parseDraft(JSON.stringify({ version: DRAFT_VERSION, chosen: "a-1", agents: { "a-1": { cwd: 7, limits: "no" } } }));
    expect(bent).toEqual({ version: DRAFT_VERSION, chosen: [], dropped: [], agents: { "a-1": { id: "a-1" } } });
  });
});

describe("158: an agent deleted and created again under the same name", () => {
  const recreatedConfig = (): Config => {
    const config = existing();
    config.agents["dev-bot-mdden"] = { ...config.agents["dev-bot-mdden"], id: "a-old" };
    return config;
  };

  it("158-S1: the entry is asked about as recreated, and the dead id is never offered as a row", () => {
    const choices = agentChoices(roster, recreatedConfig());
    expect(choices.recreated).toEqual([{ name: "dev-bot-mdden", id: "a-1", previousId: "a-old" }]);
    expect(choices.disappeared).toEqual([]);
    expect(choices.options.map((o) => o.value)).not.toContain("a-old");
    expect(choices.preselected).toEqual(["a-1"]);
  });

  it("158-S1: the carried-over config keeps every field of the entry and swaps only the id", () => {
    const config = recreatedConfig();
    const carried = carriedOver(config, agentChoices(roster, config).recreated);
    expect(carried?.agents["dev-bot-mdden"]).toEqual({ ...config.agents["dev-bot-mdden"], id: "a-1" });
    // Nothing to carry is the config itself, not a copy that could drift from it.
    expect(carriedOver(existing(), [])).toEqual(existing());
  });

  it("158-S1: an entry still visible under its old id is not a deletion, and two namesakes are not guessed between", () => {
    // Visible but no longer managed: the old agent and its key both still exist.
    const stillThere = agentChoices(roster, recreatedConfig(), new Set(["a-old"]));
    expect(stillThere.recreated).toEqual([]);
    expect(stillThere.disappeared).toEqual([{ name: "dev-bot-mdden", id: "a-old", reason: "no longer an agent you manage" }]);

    const twins: RosterAgent[] = [...roster, { id: "a-9", name: "dev-bot-mdden", organization: "other org", status: "active" }];
    const ambiguous = agentChoices(twins, recreatedConfig());
    expect(ambiguous.recreated).toEqual([]);
    expect(ambiguous.disappeared.map((d) => d.id)).toEqual(["a-old"]);
  });

  it("158-S1: a namesake this machine already configures is a rename of its own entry, not the dead entry's replacement", () => {
    // The roster's dev-bot-mdden is a-1, which is configured here as dev-bot and
    // was renamed onto the dead entry's name. Carrying the dead entry over to a-1
    // as well would put two entries on one id.
    const config = recreatedConfig();
    config.agents["dev-bot"] = { ...config.agents["dev-bot-mdden"], id: "a-1" };
    const choices = agentChoices(roster, config);
    expect(choices.recreated).toEqual([]);
    expect(choices.renamed).toEqual([{ from: "dev-bot", to: "dev-bot-mdden", id: "a-1" }]);
    expect(choices.disappeared).toEqual([{ name: "dev-bot-mdden", id: "a-old", reason: "no longer in the roster" }]);
    expect(choices.preselected).toEqual(["a-1"]);
  });

  it("158-S2: only a carry-over that was not declined and is still chosen needs a key minted for it", () => {
    const recreated = agentChoices(roster, recreatedConfig()).recreated;
    expect(carriedEntries(recreated, answersFor([["dev-bot-mdden", "a-1"]]))).toEqual(recreated);
    expect(carriedEntries(recreated, { ...answersFor([["dev-bot-mdden", "a-1"]]), notCarried: recreated })).toEqual([]);
    expect(carriedEntries(recreated, answersFor([["spec-warden", "a-2"]]))).toEqual([]);
  });

  it("158-S3: an entry gone with no namesake is listed unmarked; one no longer yours to manage stays marked", () => {
    const config = existing();
    config.agents["vanished-bot"] = { ...config.agents["dev-bot-mdden"], id: "a-gone" };
    config.agents["theirs-now"] = { ...config.agents["dev-bot-mdden"], id: "a-theirs" };
    const { options, preselected } = agentChoices(roster, config, new Set(["a-theirs"]));
    expect(options.find((o) => o.value === "a-gone")?.label).toBe("vanished-bot — no longer in the roster");
    expect(preselected).not.toContain("a-gone");
    expect(preselected).toContain("a-theirs");
  });

  it("158-S4: every id configured before and not after is forgotten, the carried-over entry's old id among them", () => {
    const before = recreatedConfig();
    before.agents["spec-warden"] = { ...before.agents["dev-bot-mdden"], id: "a-2" };
    const after = assembleConfig(answersFor([["dev-bot-mdden", "a-1"]]));
    expect(idsToForget(before, after).sort()).toEqual(["a-2", "a-old"]);
    expect(idsToForget(null, after)).toEqual([]);
  });

  it("158-S5: a failed mint with a key still held names the prefix and the check, and does not say there is no key", () => {
    const config = assembleConfig(answersFor([["dev-bot-mdden", "a-1"]]));
    const report = { path: "/c/config.json", mcpPaths: {}, removed: [] };
    const held = summaryLines(config, report, [], [], {
      "dev-bot-mdden": { kind: "failed", problem: "Agent not found", heldPrefix: "ab12cd34" },
    }).join("\n");
    expect(held).toContain("the server would not mint a new key (Agent not found)");
    expect(held).toContain("The key already on this machine (smd_agent_ab12cd34…) was kept, and may not work");
    expect(held).toContain("mdbrain agents check dev-bot-mdden");
    expect(held).not.toContain("no connection key");

    const none = summaryLines(config, report, [], [], { "dev-bot-mdden": { kind: "failed", problem: "Agent not found" } }).join("\n");
    expect(none).toContain("no connection key: Agent not found.");
  });

  it("158-S2: the summary says an entry was carried over, and says so when one was declined", () => {
    const report = { path: "/c/config.json", mcpPaths: {}, removed: [] };
    const carried = summaryLines(assembleConfig(answersFor([["dev-bot-mdden", "a-1"]])), report, [], [], {
      "dev-bot-mdden": { kind: "carried" },
    }).join("\n");
    expect(carried).toContain("carried over from the deleted agent: a connection key was requested for the new one");

    const recreated = [{ name: "dev-bot-mdden", id: "a-1", previousId: "a-old" }];
    const declined = summaryLines(assembleConfig(answersFor([["spec-warden", "a-2"]])), report, [], [], {}, recreated).join("\n");
    expect(declined).toContain("dev-bot-mdden was dropped: it was deleted and created again in markdownbrain.ai");
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

  it("121-S3: draws the roster as an arrow-key list, asks the per-agent questions in order, and ends on the ceiling", async () => {
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(
      configureScreen(plan({ emptyOrganizations: ["quiet org"], withheld: "One agent is not shown here." }), (a) => { done = a; }),
    );
    await tick();
    expect(lastFrame()).toContain("Which agents does this machine run?");
    expect(lastFrame()).toContain("markdownbrain.ai / dev-bot-mdden");
    expect(lastFrame()).toContain("old-bot (disabled)");
    expect(lastFrame()).toContain("No agents yet in: quiet org.");
    expect(lastFrame()).toContain("One agent is not shown here.");
    // Space marks the first row, Enter confirms the selection.
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Which of them poll for work?");
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("dev-bot-mdden (1 of 1)");
    expect(lastFrame()).toContain("Where does dev-bot-mdden run?");
    for (const _question of ["cwd", "pays-for", "variable"]) {
      stdin.write("\r");
      await tick();
    }
    // Nothing about limits: an agent starts with none, and they are set from the menu.
    expect(lastFrame()).toContain("Most sessions an hour");
    // No question follows it: the poll is a constant, so answering the ceiling
    // is what finishes the wizard.
    expect(lastFrame()).not.toContain("How often to ask for work");
    stdin.write("\r");
    await tick();
    expect(done).not.toBeNull();
    const answers = done as unknown as Answers;
    expect(answers.agents.map((a) => a.name)).toEqual(["dev-bot-mdden"]);
    expect(answers.agents[0].cwd).toBe(cwd);
    expect(answers.agents[0].harnessVariable).toBe("ANTHROPIC_API_KEY");
    expect(answers.agents[0].connectionKeyVariable).toBe("MDBRAIN_KEY_DEV_BOT_MDDEN");
    expect(answers.sessionsPerHour).toBeNull();
    expect(answers).not.toHaveProperty("poll");
    expect(answers.dropped).toEqual([]);
    // And the file those answers write holds no poll either, which is the half a
    // walkthrough can check that `assembleConfig` alone cannot.
    expect(serializeConfig(assembleConfig(answers))).not.toContain("poll");
  });

  it("125-S24: the work question follows the list, and an unmarked agent is asked only what reaches an attended session", async () => {
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(plan(), (a) => { done = a; }));
    await tick();
    // Mark both agents on the first list.
    stdin.write(" ");
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();

    expect(lastFrame()).toContain("Which of them poll for work?");
    expect(lastFrame()).toContain("mdbrain as <agent> starts a session as it");
    // Only the two just chosen, never the third agent on the roster.
    expect(lastFrame()).toContain("dev-bot-mdden");
    expect(lastFrame()).toContain("spec-warden");
    expect(lastFrame()).not.toContain("old-bot");

    // Unmark the second, so one is asked for work and one is an identity.
    stdin.write(DOWN);
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();

    // The first is asked all three questions.
    expect(lastFrame()).toContain("dev-bot-mdden (1 of 2)");
    for (const _question of ["cwd", "pays-for", "variable"]) {
      stdin.write("\r");
      await tick();
    }
    expect(lastFrame()).toContain("spec-warden (2 of 2)");
    // The second is asked the same three, which all reach an attended session.
    stdin.write("\r"); // cwd
    await tick();
    expect(lastFrame()).toContain("What pays for spec-warden's thinking?");
    stdin.write("\r");
    await tick();
    stdin.write("\r"); // the variable
    await tick();
    expect(lastFrame()).toContain("Most sessions an hour");
    stdin.write("\r");
    await tick();

    const answers = done as unknown as Answers;
    expect(answers.agents.map((a) => [a.name, a.pollsWork])).toEqual([["dev-bot-mdden", true], ["spec-warden", false]]);
    expect(answers.agents[1].limits).toEqual({});
    expect(answers.agents[1].cwd).toBe(cwd);
  });

  it("125-S26: the work answer is recorded in the draft, and an unanswered one is not invented", async () => {
    const drafts: ConfigureDraft[] = [];
    const { stdin } = render(configureScreen(plan({ record: (d) => drafts.push(d) }), () => {}));
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r"); // the selection: recorded before the work question is answered
    await tick();
    expect(drafts.at(-1)?.chosen).toEqual(["a-1"]);
    expect(drafts.at(-1)).not.toHaveProperty("pollers");

    stdin.write(" "); // unmark it: this machine holds its identity and asks for no work
    await tick();
    stdin.write("\r");
    await tick();
    expect(drafts.at(-1)?.pollers).toEqual([]);
    // Read back as text, since a draft only reaches a later run as a file.
    expect(parseDraft(JSON.stringify(drafts.at(-1)))?.pollers).toEqual([]);

    // And a run that widens the list records no answer rather than the earlier
    // one: `chosen` is the only record of which agents an answer was given
    // about, so keeping it beside a wider list would tell the next run that a
    // newly marked agent had been asked and had said no.
    const resumed: ConfigureDraft[] = [];
    const later = render(
      configureScreen(plan({ draft: drafts.at(-1) as ConfigureDraft, record: (d) => resumed.push(d) }), () => {}),
    );
    await tick();
    later.stdin.write(DOWN);
    await tick();
    later.stdin.write(" ");
    await tick();
    later.stdin.write("\r");
    await tick();
    expect(resumed.at(-1)?.chosen).toEqual(["a-1", "a-2"]);
    expect(resumed.at(-1)).not.toHaveProperty("pollers");
    expect(
      pollingChoices(["a-1", "a-2"], agentChoices(roster, null).options, null, resumed.at(-1) as ConfigureDraft).preselected,
    ).toEqual(["a-1", "a-2"]);
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
    stdin.write("\r"); // every marked agent is asked for work by default
    await tick();
    stdin.write("\r"); // cwd
    await tick();
    expect(lastFrame()).toContain("What pays for dev-bot-mdden's thinking?");
    stdin.write(DOWN); // from the variable, offered first because that is the default, to the account
    await tick();
    stdin.write("\r");
    await tick();
    // Straight to the ceiling: there is no variable to name.
    expect(lastFrame()).toContain("Most sessions an hour");
    stdin.write("\r");
    await tick();
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
    stdin.write("\r"); // every marked agent is asked for work by default
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
    stdin.write("\r"); // every marked agent is asked for work by default
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
    stdin.write("\r"); // every marked agent is asked for work by default
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
    stdin.write("\r"); // the agents asked for work: every one of them
    await tick();
    stdin.write("\r"); // cwd
    await tick();
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    const latest = drafts[drafts.length - 1];
    expect(latest.chosen).toEqual(["a-1"]);
    expect(latest.pollers).toEqual(["a-1"]);
    expect(latest.agents["a-1"].cwd).toBe(cwd);
  });

  it("105-S49: the draft's answers are what the next run offers, ahead of the config's", async () => {
    const config = existing();
    let done: Answers | null = null;
    const draft: ConfigureDraft = {
      version: DRAFT_VERSION,
      chosen: ["a-2"],
      dropped: [],
      agents: { "a-2": { id: "a-2", cwd, harnessVariable: null, limits: { maxBudgetUsd: 1, wallClock: "9m" } } },
      sessionsPerHour: 3,
    };
    const { lastFrame, stdin } = render(
      configureScreen(plan({ choices: agentChoices(roster, config), existing: config, draft }), (a) => { done = a; }),
    );
    await tick();
    // spec-warden is the draft's and not the config's, so its questions come
    // first; taking each offered answer has to land the draft's values.
    expect(lastFrame()).toContain("Where does spec-warden run?");
    for (let i = 0; i < 10 && !lastFrame()!.includes("Save and leave"); i += 1) {
      stdin.write("\r");
      await tick();
    }
    // The menu holds what the draft marked, spec-warden, not the config's dev-bot-mdden.
    expect(lastFrame()).toContain("spec-warden");
    expect(lastFrame()).not.toContain("dev-bot-mdden");
    expect(lastFrame()).toContain("$1 · 9m");
    // Down past Add or remove and Sessions an hour to Save and leave.
    for (let i = 0; i < 3; i += 1) {
      stdin.write(DOWN);
      await tick();
    }
    stdin.write("\r");
    await tick();
    const answers = done as unknown as Answers;
    expect(answers.agents[0].name).toBe("spec-warden");
    expect(answers.agents[0].harnessVariable).toBeNull();
    expect(answers.agents[0].limits).toEqual({ maxBudgetUsd: 1, wallClock: "9m" });
    expect(answers.sessionsPerHour).toBe(3);
  });

  it("carries a configured ceiling over on a re-run, so saving the menu keeps it rather than dropping it", async () => {
    const config = existing();
    config.sessionsPerHour = 4;
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(plan({ choices: agentChoices(roster, config), existing: config }), (a) => { done = a; }));
    await tick();
    expect(lastFrame()).toMatch(/Sessions an hour\s+4/);
    for (let i = 0; i < 3; i++) { stdin.write(DOWN); await tick(); }
    stdin.write("\r"); // Save and leave
    await tick();
    expect((done as unknown as Answers).sessionsPerHour).toBe(4);
    expect((done as unknown as Answers).agents[0].limits).toEqual({ maxBudgetUsd: 3, wallClock: "20m" });
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
    // Kept, so the menu opens with the entry under its new name.
    expect(kept.lastFrame()).toContain("Save and leave");
    expect(kept.lastFrame()).toMatch(/› dev-bot-mdden\s+polls/);
    expect(kept.lastFrame()).toContain("1 change");

    let done: Answers | null = null;
    const dropped = render(configureScreen(renamedPlan, (a) => { done = a; }));
    await tick();
    dropped.stdin.write("n");
    await tick();
    // Nothing configured is left to put on a menu, so it is the walk's list.
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
  it("158-S1: asks whether to carry a recreated agent over; yes keeps every answer under the new id", async () => {
    const config = existing();
    config.agents["dev-bot-mdden"] = { ...config.agents["dev-bot-mdden"], id: "a-old" };
    const choices = agentChoices(roster, config);
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(
      configureScreen(plan({ choices, existing: carriedOver(config, choices.recreated) }), (a) => { done = a; }),
    );
    await tick();
    // The frame wraps a long line, so the question is checked in pieces that each fit on one.
    expect(lastFrame()).toContain("dev-bot-mdden was deleted and created again");
    expect(lastFrame()).toContain("over to the new one?");
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Save and leave");
    expect(lastFrame()).not.toContain("no longer in the roster");
    // The carry-over is a change the file will show, so it is counted.
    expect(lastFrame()).toContain("1 change");
    for (let i = 0; i < 3; i++) { stdin.write(DOWN); await tick(); }
    stdin.write("\r");
    await tick();
    const answers = done as unknown as Answers;
    expect(answers.agents.map((a) => [a.name, a.id])).toEqual([["dev-bot-mdden", "a-1"]]);
    expect(answers.agents[0].cwd).toBe(cwd);
    expect(answers.agents[0].limits).toEqual({ maxBudgetUsd: 3, wallClock: "20m" });
    expect(answers.notCarried).toEqual([]);
  });

  it("158-S1: no drops the entry, so the list arrives with the new agent unmarked", async () => {
    const config = existing();
    config.agents["dev-bot-mdden"] = { ...config.agents["dev-bot-mdden"], id: "a-old" };
    const choices = agentChoices(roster, config);
    const { lastFrame, stdin } = render(configureScreen(plan({ choices, existing: carriedOver(config, choices.recreated) }), () => {}));
    await tick();
    stdin.write("n");
    await tick();
    expect(lastFrame()).toContain("Which agents does this machine run?");
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Pick at least one agent");
  });
  const ESC = "\u001b";
  const UP = "\u001b[A";
  const other = process.platform === "win32" ? "C:\\work\\other" : "/work/other";
  const menuPlan = (config: Config = existing(), over: Partial<ScreenPlan> = {}) =>
    plan({ choices: agentChoices(roster, config), existing: config, isDirectory: (p) => p === cwd || p === other, ...over });
  /** Two agents, the second identity-only, so the menu has both kinds of line. */
  const twoAgents = (): Config => {
    const config = existing();
    config.agents["spec-warden"] = { ...config.agents["dev-bot-mdden"], id: "a-2", pollsWork: false, env: { harness: null, connectionKey: "MDBRAIN_KEY_SPEC_WARDEN" }, limits: {} };
    return config;
  };

  it("177-S11: the walk asks nothing about limits, and the saved agent has none", async () => {
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(plan(), (a) => { done = a; }));
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("\r"); // polls
    await tick();
    const asked: string[] = [];
    while (done === null && asked.length < 6) {
      asked.push(lastFrame() ?? "");
      stdin.write("\r");
      await tick();
    }
    expect(asked.join("\n")).not.toMatch(/dollars|Longest a session|turns|[Ll]imit/);
    const answers = done as unknown as Answers;
    expect(answers.agents[0].limits).toEqual({});
    expect(JSON.parse(serializeConfig(assembleConfig(answers))).agents["dev-bot-mdden"]).not.toHaveProperty("limits");
  });

  it("177-S12: a config opens the menu: every agent with its summary, then the three rows", async () => {
    const { lastFrame } = render(configureScreen(menuPlan(twoAgents()), () => {}));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Which agents does this machine run?");
    expect(frame).toMatch(/› dev-bot-mdden\s+polls · .*checkout · \$3 · 20m/);
    expect(frame).toMatch(/spec-warden\s+identity only · /);
    const order = ["dev-bot-mdden", "spec-warden", "Add or remove agents…", "Sessions an hour", "Save and leave"].map((s) => frame.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(frame).toMatch(/Sessions an hour\s+server's ceiling \(10\)/);
    expect(frame).toMatch(/Save and leave\s+no changes/);
  });

  it("177-S13: one value, one edit: a new directory changes only that agent's cwd, and the menu counts 1 change", async () => {
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(menuPlan(twoAgents()), (a) => { done = a; }));
    await tick();
    stdin.write("\r"); // open dev-bot-mdden
    await tick();
    expect(lastFrame()).toMatch(/› Directory\s+/);
    stdin.write("\r"); // Directory
    await tick();
    expect(lastFrame()).toContain("Where does dev-bot-mdden run?");
    stdin.write(backspaces(cwd.length));
    await tick();
    for (const c of other) stdin.write(c);
    await tick();
    stdin.write("\r");
    await tick();
    expect((lastFrame() ?? "").split("\n").some((line) => line.includes("Directory") && line.includes(other))).toBe(true);
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toMatch(/Save and leave\s+1 change/);
    for (let i = 0; i < 4; i++) { stdin.write(DOWN); await tick(); }
    stdin.write("\r");
    await tick();
    const answers = done as unknown as Answers;
    const after = assembleConfig(answers);
    expect(after.agents["dev-bot-mdden"]).toEqual({ ...twoAgents().agents["dev-bot-mdden"], cwd: other });
    expect(after.agents["spec-warden"]).toEqual(twoAgents().agents["spec-warden"]);
  });

  it("177-S14: a polling agent has exactly one row about limits, reading none; an identity-only agent has none", () => {
    const polling = agentDefaults("dev-bot-mdden", { ...existing().agents["dev-bot-mdden"], limits: {} }, cwd);
    const rows = agentRows(polling);
    expect(rows.filter((r) => r.kind === "limits")).toEqual([{ kind: "limits", label: "Limits", value: "none" }]);
    expect(rows.map((r) => r.label)).toEqual(["Directory", "Pays with", "Key variable", "Polls for work", "Limits"]);
    expect(agentRows({ ...polling, pollsWork: false }).some((r) => r.kind === "limits")).toBe(false);
    expect(agentRows({ ...polling, harnessVariable: null }).some((r) => r.kind === "variable")).toBe(false);
  });

  it("177-S15: setting the wall clock from the menu reads 2h and saves only that limit", async () => {
    const config = existing();
    config.agents["dev-bot-mdden"].limits = {};
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(menuPlan(config), (a) => { done = a; }));
    await tick();
    stdin.write("\r"); // open the agent
    await tick();
    for (let i = 0; i < 4; i++) { stdin.write(DOWN); await tick(); } // to Limits
    expect(lastFrame()).toMatch(/› Limits\s+none/);
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Most dollars a session of dev-bot-mdden may spend. Blank for none.");
    stdin.write("\r"); // budget left blank
    await tick();
    expect(lastFrame()).toContain("Longest a session of dev-bot-mdden may run");
    for (const c of "2h") stdin.write(c);
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toMatch(/› Limits\s+2h/);
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toMatch(/dev-bot-mdden\s+polls · .* · 2h/);
    for (let i = 0; i < 3; i++) { stdin.write(DOWN); await tick(); }
    stdin.write("\r");
    await tick();
    const saved = JSON.parse(serializeConfig(assembleConfig(done as unknown as Answers)));
    expect(saved.agents["dev-bot-mdden"].limits).toEqual({ wallClock: "2h" });
  });

  it("177-S19: openAt naming a recreated agent by its old id opens that agent's rows once it is carried over", async () => {
    // `mdbrain agents` hands over the id in the file, which for a recreated
    // entry is the deleted agent's, while the screen already reads the new one.
    const config = existing();
    config.agents["dev-bot-mdden"] = { ...config.agents["dev-bot-mdden"], id: "a-old" };
    const choices = agentChoices(roster, config);
    const { lastFrame, stdin } = render(configureScreen(plan({ choices, existing: carriedOver(config, choices.recreated), openAt: "a-old" }), () => {}));
    await tick();
    stdin.write("y");
    await tick();
    expect(lastFrame()).toContain("Esc back to the menu");
    expect(lastFrame()).toMatch(/› Directory\s+/);
  });

  it("177-S16: Esc goes back one level, and asks before leaving changes unsaved; only y leaves", async () => {
    let done: Answers | null = null;
    let unchanged = false;
    const screen = render(configureScreen(menuPlan(), (a) => { done = a; }, () => { unchanged = true; }));
    await tick();
    screen.stdin.write("\r");
    await tick();
    expect(screen.lastFrame()).toContain("Esc back to the menu");
    screen.stdin.write(ESC);
    await tick();
    expect(screen.lastFrame()).toContain("Save and leave");
    // A change: the ceiling, from the menu.
    screen.stdin.write(DOWN);
    await tick();
    screen.stdin.write(DOWN);
    await tick();
    screen.stdin.write("\r");
    await tick();
    for (const c of "4") screen.stdin.write(c);
    await tick();
    screen.stdin.write("\r");
    await tick();
    expect(screen.lastFrame()).toMatch(/Save and leave\s+1 change/);
    screen.stdin.write(ESC);
    await tick();
    expect(screen.lastFrame()).toContain("Leave without saving 1 change? y to leave, any other key to stay.");
    screen.stdin.write("n");
    await tick();
    expect(screen.lastFrame()).toContain("Save and leave");
    expect(screen.lastFrame()).not.toContain("Leave without saving");
    screen.stdin.write(ESC);
    // An Esc followed too quickly by y reads as one Meta-y, so it is given time to land alone.
    await tick();
    await tick();
    screen.stdin.write("y");
    await tick();
    expect(done).toBeNull();
    expect(unchanged).toBe(false);

    // With nothing changed, Esc simply leaves, and says so.
    const quiet = render(configureScreen(menuPlan(), (a) => { done = a; }, () => { unchanged = true; }));
    await tick();
    quiet.stdin.write(ESC);
    await tick();
    expect(unchanged).toBe(true);
    expect(done).toBeNull();
  });

  it("177-S18: the menu's Directory row refuses a directory that does not exist with the walk's own sentence", async () => {
    const { lastFrame, stdin } = render(configureScreen(menuPlan(), () => {}));
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write(backspaces(cwd.length));
    await tick();
    for (const c of "/nowhere") stdin.write(c);
    await tick();
    stdin.write("\r");
    await tick();
    const walk = judgeCwd("/nowhere", cwd, () => false);
    expect(!walk.ok && walk.problem).toBe("/nowhere is not a directory that exists.");
    expect(lastFrame()).toContain("/nowhere is not a directory that exists.");
    // Still editing, with what was typed, as the walk does.
    expect(lastFrame()).toContain("Where does dev-bot-mdden run?");
  });

  it("177-S12: Add or remove agents… adds one, walks only its questions, and comes back to the menu with it", async () => {
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(menuPlan(), (a) => { done = a; }));
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write("\r"); // Add or remove agents…
    await tick();
    expect(lastFrame()).toContain("Which agents does this machine run?");
    stdin.write(DOWN);
    await tick();
    stdin.write(" "); // mark spec-warden too
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("\r"); // both poll
    await tick();
    expect(lastFrame()).toContain("Where does spec-warden run?");
    for (let i = 0; i < 3; i++) { stdin.write("\r"); await tick(); }
    expect(lastFrame()).toContain("Save and leave");
    expect(lastFrame()).toMatch(/spec-warden\s+polls · .* · no limits/);
    expect(lastFrame()).toMatch(/Save and leave\s+1 change/);
    stdin.write(UP);
    await tick();
    for (let i = 0; i < 4; i++) { stdin.write(DOWN); await tick(); }
    stdin.write("\r");
    await tick();
    const answers = done as unknown as Answers;
    expect(answers.agents.map((a) => a.name)).toEqual(["dev-bot-mdden", "spec-warden"]);
    expect(answers.agents[0].limits).toEqual({ maxBudgetUsd: 3, wallClock: "20m" });
  });

  it("177-S19: openAt opens the menu on that agent's rows", async () => {
    const { lastFrame } = render(configureScreen(menuPlan(twoAgents(), { openAt: "a-2" }), () => {}));
    await tick();
    expect(lastFrame()).toContain("Esc back to the menu");
    expect(lastFrame()).toMatch(/spec-warden\n.*› Directory/);
  });
  it("177-S16: leaving changes unsaved with y tells the command they were discarded, which Ctrl-C does not", async () => {
    let discarded = false;
    const screen = render(configureScreen(menuPlan(), () => {}, () => {}, () => { discarded = true; }));
    await tick();
    for (let i = 0; i < 2; i++) { screen.stdin.write(DOWN); await tick(); }
    screen.stdin.write("\r");
    await tick();
    screen.stdin.write("4");
    await tick();
    screen.stdin.write("\r");
    await tick();
    screen.stdin.write(ESC);
    // An Esc followed too quickly by y reads as one Meta-y, so it is given time to land alone.
    await tick();
    await tick();
    screen.stdin.write("y");
    await tick();
    expect(discarded).toBe(true);
  });

  it("177-S16: Esc inside Add or remove agents… goes back to the menu as it was", async () => {
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(menuPlan(), (a) => { done = a; }));
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(" ");
    await tick();
    stdin.write("\r"); // on to the pollers
    await tick();
    expect(lastFrame()).toContain("Which of them poll for work?");
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toContain("Save and leave");
    expect(lastFrame()).not.toContain("spec-warden");
    expect(lastFrame()).toMatch(/Save and leave\s+no changes/);
    for (let i = 0; i < 2; i++) { stdin.write(DOWN); await tick(); }
    stdin.write("\r");
    await tick();
    expect((done as unknown as Answers).agents.map((a) => a.name)).toEqual(["dev-bot-mdden"]);
  });

  it("177-S22: Esc on the key variable after switching Pays with to a key leaves the agent on the account", async () => {
    const config = existing();
    config.agents["dev-bot-mdden"].env = { harness: null, connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" };
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(menuPlan(config, { env: { MDBRAIN_KEY_DEV_BOT_MDDEN: "set" } }), (a) => { done = a; }));
    await tick();
    stdin.write("\r"); // open the agent
    await tick();
    stdin.write(DOWN); // Pays with
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write(DOWN); // the API key option
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Which environment variable holds dev-bot-mdden's harness credential?");
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toMatch(/› Pays with\s+this machine's own Claude Code account/);
    expect(lastFrame()).not.toContain("Key variable");
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toMatch(/Save and leave\s+no changes/);
    stdin.write(ESC);
    await tick();
    expect(done).toBeNull();
  });

  it("177-S22: switching Pays with to a key is kept once its variable is named, and counts as 1 change", async () => {
    const config = existing();
    config.agents["dev-bot-mdden"].env = { harness: null, connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" };
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(
      configureScreen(menuPlan(config, { env: { MDBRAIN_KEY_DEV_BOT_MDDEN: "set", ANTHROPIC_API_KEY: "set" } }), (a) => { done = a; }),
    );
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("\r"); // the variable offered
    await tick();
    expect(lastFrame()).toMatch(/Key variable\s+ANTHROPIC_API_KEY/);
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toMatch(/Save and leave\s+1 change/);
    for (let i = 0; i < 3; i += 1) { stdin.write(DOWN); await tick(); }
    stdin.write("\r");
    await tick();
    expect((done as unknown as Answers).agents[0].harnessVariable).toBe("ANTHROPIC_API_KEY");
  });

  it("177-S23: an agent only a restarted draft chose is asked its questions before the menu, and Esc leaves it off", async () => {
    const draft: ConfigureDraft = { version: DRAFT_VERSION, chosen: ["a-1", "a-2"], pollers: ["a-1", "a-2"], agents: {}, dropped: [] };
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(menuPlan(existing(), { draft }), (a) => { done = a; }));
    await tick();
    expect(lastFrame()).toContain("spec-warden (new agent)");
    expect(lastFrame()).toContain("Where does spec-warden run?");
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toMatch(/Save and leave\s+no changes/);
    expect(lastFrame()).not.toContain("spec-warden");
    stdin.write(ESC);
    await tick();
    expect(done).toBeNull();
  });

  it("177-S24: Esc on a draft's agent that replaced every configured one goes back to the list, never to an empty menu", async () => {
    const config = existing();
    const draft: ConfigureDraft = { version: DRAFT_VERSION, chosen: ["a-2"], dropped: [], agents: {} };
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(
      configureScreen(plan({ choices: agentChoices(roster, config), existing: config, draft }), (a) => { done = a; }),
    );
    await tick();
    expect(lastFrame()).toContain("Where does spec-warden run?");
    stdin.write(ESC);
    await tick();
    // An empty menu here would offer *Save and leave* with `agents: []`, a file
    // every command refuses, and lose dev-bot-mdden's key on this machine.
    expect(lastFrame()).not.toContain("Save and leave");
    expect(lastFrame()).toContain("Which agents does this machine run?");
    expect(lastFrame()).toContain("Pick at least one agent");
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toContain("Which agents does this machine run?");
    expect(done).toBeNull();
    // The draft's mark is still on the list, so Enter walks spec-warden again.
    stdin.write("\r");
    await tick();
    for (let i = 0; i < 10 && !lastFrame()!.includes("Save and leave"); i += 1) {
      stdin.write("\r");
      await tick();
    }
    expect(lastFrame()).toContain("Save and leave");
    expect(lastFrame()).toContain("spec-warden");
  });

  it("177-S12: a configured agent deleted from the roster is named on the menu and dropped by saving", async () => {
    const config = existing();
    config.agents["vanished-bot"] = { ...config.agents["dev-bot-mdden"], id: "a-gone" };
    let done: Answers | null = null;
    const { lastFrame, stdin } = render(configureScreen(menuPlan(config), (a) => { done = a; }));
    await tick();
    expect(lastFrame()).toContain("vanished-bot is no longer in the roster, so saving drops it.");
    expect(lastFrame()).toMatch(/Save and leave\s+1 change/);
    for (let i = 0; i < 3; i++) { stdin.write(DOWN); await tick(); }
    stdin.write("\r");
    await tick();
    expect((done as unknown as Answers).agents.map((a) => a.name)).toEqual(["dev-bot-mdden"]);
  });

  it("177: a save the screen cannot show — old limits, --new-keys — still counts, so Esc asks", async () => {
    let unchanged = false;
    const { lastFrame, stdin } = render(configureScreen(menuPlan(existing(), { pending: 1 }), () => {}, () => { unchanged = true; }));
    await tick();
    expect(lastFrame()).toMatch(/Save and leave\s+1 change/);
    stdin.write(ESC);
    await tick();
    expect(unchanged).toBe(false);
    expect(lastFrame()).toContain("Leave without saving 1 change?");
  });

  it("177: a draft that blanked the ceiling keeps it blank on the menu, rather than the config's", async () => {
    const config = existing();
    config.sessionsPerHour = 5;
    const draft: ConfigureDraft = { version: DRAFT_VERSION, chosen: ["a-1"], dropped: [], agents: {}, sessionsPerHour: null };
    const { lastFrame } = render(configureScreen(menuPlan(config, { draft }), () => {}));
    await tick();
    expect(lastFrame()).toMatch(/Sessions an hour\s+server's ceiling \(10\)/);
    expect(lastFrame()).toMatch(/Save and leave\s+1 change/);
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
          ? [{ id: "a-1", org_id: "o-1", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-dev-bot" }]
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
    platform: "win32",
    ...over,
  });

  /** A store that keeps keys where macOS would ask a person about them. */
  const keychainStore = (): ConnectionKeyStore => ({ ...memoryKeyStore(), backend: { kind: "keychain", where: "the keychain" } });

  it("on macOS it says which button to choose before the keychain can ask, and says it once", async () => {
    validSession();
    const { out, context } = io();
    const code = await withFetch(rosterReply, () =>
      runConfigure(deps({ platform: "darwin", openKeyStore: async () => keychainStore() }), context),
    );
    expect(code).toBe(0);
    const said = out.filter((line) => line.includes("Always Allow"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Allow grants a single read");
    // Ahead of the summary, because a summary is read once the dialog has
    // already been answered and the choice it is about has been made.
    expect(out.indexOf(said[0])).toBeLessThan(out.findIndex((line) => line.startsWith("Configuration written to")));
  });

  it("no other platform is told about a dialog it will never see, and neither is the file fallback", async () => {
    validSession();
    const { out: onWindows, context: windows } = io();
    await withFetch(rosterReply, () => runConfigure(deps({ platform: "win32", openKeyStore: async () => keychainStore() }), windows));
    expect(onWindows.join("\n")).not.toContain("Always Allow");

    const { out: onLinux, context: linux } = io();
    await withFetch(rosterReply, () => runConfigure(deps({ platform: "linux", openKeyStore: async () => keychainStore() }), linux));
    expect(onLinux.join("\n")).not.toContain("Always Allow");

    // A key going into a file is nobody's permission to grant.
    const { out: onFile, context: file } = io();
    await withFetch(rosterReply, () => runConfigure(deps({ platform: "darwin" }), file));
    expect(onFile.join("\n")).not.toContain("Always Allow");
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

  it("121-S21: `configure` says where the key is held in either case, which is where that disclosure now lives", async () => {
    // `run` says it only on the file fallback, because a line on every start
    // about a keychain is what a person already assumed. Here somebody is asking
    // rather than being told, so both branches are part of the answer — and this
    // is what makes the change in `run` a change of venue and not a deletion.
    for (const backend of [
      { kind: "keychain", where: "the keychain" } as const,
      { kind: "file", where: "/tmp/secrets.json", reason: "this runtime has no keychain to put it in" } as const,
    ]) {
      validSession();
      const { out, context } = io();
      const store = { ...memoryKeyStore(), backend };
      const code = await withFetch(rosterReply, () => runConfigure(deps({ openKeyStore: async () => store }), context));
      expect(code).toBe(0);
      expect(out.at(-1)).toContain(`Connection keys are held in ${backend.where}`);
    }
  });

  // The refusal branch of the roster read, which nothing reached before. It
  // decides two things at once: which command the sentence tells somebody to run
  // again, and whether the server's own words are redacted on the way out. `run`
  // and `whoami` are both asserted this way, and this is the third of the four
  // call sites that print such a body.
  it("99-S11: a refused roster names `mdbrain configure` first, and redacts the server's words", async () => {
    validSession();
    const signature = "c2lnbmF0dXJlX2hlcmU";
    const refusedReply = (url: string) =>
      url.includes("/auth/v1/user")
        ? new Response(
            JSON.stringify({
              code: 403,
              msg: `Session from session_id claim in JWT does not exist (eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${signature})`,
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          )
        : rosterReply(url);
    const { err, context } = io();
    const code = await withFetch(refusedReply, () => runConfigure(deps(), context));
    expect(code).toBe(1);
    const said = err.join("\n");
    expect(said.indexOf("mdbrain configure")).toBeGreaterThan(-1);
    expect(said.indexOf("mdbrain configure")).toBeLessThan(said.indexOf("mdbrain login"));
    expect(said).toContain("[redacted]");
    expect(said).not.toContain(signature);
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
    expect(out.some((l) => l.includes("requested from markdownbrain.ai and stored on this machine"))).toBe(true);
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

  it("105-S50: a key the store takes and will not give back is reported against its agent, not called stored", async () => {
    validSession();
    let written = false;
    const refusing: ConnectionKeyStore = {
      backend: { kind: "keychain", where: "the operating system's keychain" },
      async get() {
        if (!written) return null;
        throw new Error("this machine's keychain will not let this copy of mdbrain read a key an earlier copy stored");
      },
      async set() {
        written = true;
      },
      async forget() {},
    };
    const { out, context } = io();
    const code = await withFetch(rosterReply, () => runConfigure(deps({ openKeyStore: async () => refusing }), context));
    expect(code).toBe(0);
    expect(existsSync(configPath())).toBe(true);
    expect(out.some((l) => l.includes("no connection key") && l.includes("will not let this copy of mdbrain"))).toBe(true);
    expect(out.some((l) => l.includes("stored on this machine"))).toBe(false);
  });

  // Both halves of *did not return it*: a store that answers nothing after the
  // write, and one that answers a value which is not the key just written. Only
  // the second tells the read-back's comparison against the key apart from a
  // bare check for null. Each answers nothing *before* the write, because a
  // store already holding something for the agent is `held` and never written.
  it.each([
    ["answers nothing", null],
    ["answers a different value", "a-key-this-machine-never-asked-for"],
  ])("105-S50: a key the store %s for is not a key stored on this machine", async (_name, answer) => {
    validSession();
    let written = false;
    const forgetful: ConnectionKeyStore = {
      backend: { kind: "keychain", where: "the operating system's keychain" },
      get: async () => (written ? answer : null),
      set: async () => {
        written = true;
      },
      forget: async () => {},
    };
    const { out, context } = io();
    const code = await withFetch(rosterReply, () => runConfigure(deps({ openKeyStore: async () => forgetful }), context));
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("no connection key") && l.includes("did not return it"))).toBe(true);
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
    expect(err[0]).toMatch(/Create one in markdownbrain.ai first/);
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
    expect(err).toEqual([NOTHING_TO_MANAGE]);
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
                  { id: "a-1", org_id: "o-1", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-dev-bot" },
                  { id: "z-1", org_id: "o-9", display_name: "someone-elses-bot", status: "active", bot_user_id: "u-someone-else" },
                ]),
                { status: 200 },
              )
            : rosterReply(url),
      () => runConfigure(deps({ ask: async (p) => { seen = p; return answersFor([["dev-bot-mdden", "a-1"]]); } }), context),
    );
    const seenPlan = seen as unknown as ScreenPlan;
    expect(seenPlan.choices.options.map((o) => o.name)).toEqual(["dev-bot-mdden"]);
    expect(seenPlan.withheld).toMatch(/One agent is not shown/);
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
  it("158-S23: --new-keys revokes the replaced key once the new one is read back, and the summary names it", async () => {
    validSession();
    const store = memoryKeyStore({ "a-1": "smd_agent_ab12cd34_old" });
    const calls: string[] = [];
    const { out, context } = io();
    context.flags["new-keys"] = true;
    const reply = (url: string, init?: RequestInit) => {
      if (url.includes("rpc/mint_agent_key")) calls.push(`mint, store holds ${store.held.get("a-1")}`);
      if (url.includes("rpc/list_agent_keys")) {
        calls.push(`list, store holds ${store.held.get("a-1")}`);
        return new Response(JSON.stringify([{ id: "k-old", key_prefix: "ab12cd34", created_at: "2026-10-01", last_used_at: null, revoked_at: null }]), { status: 200 });
      }
      if (url.includes("rpc/revoke_agent_key")) {
        calls.push(`revoke ${String(init?.body)}`);
        return new Response(null, { status: 204 });
      }
      return rosterReply(url);
    };
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(reply(String(input), init))) as typeof fetch;
    try {
      expect(await runConfigure(deps({ openKeyStore: async () => store }), context)).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([
      "mint, store holds smd_agent_ab12cd34_old",
      "list, store holds smd_agent_abcdef01_minted",
      'revoke {"p_key_id":"k-old"}',
    ]);
    const said = out.join("\n");
    expect(said).toContain("replacing the one that was here, which was revoked (smd_agent_ab12cd34…)");
    expect(said).not.toContain("stays live until it is revoked in the app");
  });

  it("158-S23: a revoke that fails leaves the summary naming the replaced key as still live", async () => {
    validSession();
    const store = memoryKeyStore({ "a-1": "smd_agent_ab12cd34_old" });
    const { out, context } = io();
    context.flags["new-keys"] = true;
    const code = await withFetch(
      (url) =>
        url.includes("rpc/list_agent_keys")
          ? new Response(JSON.stringify({ message: "permission denied" }), { status: 403 })
          : rosterReply(url),
      () => runConfigure(deps({ openKeyStore: async () => store }), context),
    );
    expect(code).toBe(0);
    expect(store.held.get("a-1")).toBe("smd_agent_abcdef01_minted");
    expect(out.join("\n")).toContain(
      "replacing the one that was here; that key (smd_agent_ab12cd34…) is still live in markdownbrain.ai: revoke it on the agent's page",
    );
  });

  it("158-S2: a carried-over entry gets a key for its new id without --new-keys, and the old id's key is forgotten", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(configPath(), serializeConfig({ ...existing(), agents: { "dev-bot-mdden": { ...existing().agents["dev-bot-mdden"], id: "a-old" } } }));
    // A key already under the new id as well, so a mint can only be the carry-over forcing one.
    const store = memoryKeyStore({ "a-old": "smd_agent_0ld0ld00_dead", "a-1": "smd_agent_11111111_stray" });
    let mints = 0;
    let offered: ScreenPlan | null = null;
    const { out, context } = io();
    const code = await withFetch(
      (url) => {
        if (url.includes("rpc/mint_agent_key")) mints += 1;
        return rosterReply(url);
      },
      () =>
        runConfigure(
          deps({
            openKeyStore: async () => store,
            ask: async (p) => {
              offered = p;
              return answersFor([["dev-bot-mdden", "a-1"]]);
            },
          }),
          context,
        ),
    );
    expect(code).toBe(0);
    const asked = offered as unknown as ScreenPlan;
    expect(asked.choices.recreated).toEqual([{ name: "dev-bot-mdden", id: "a-1", previousId: "a-old" }]);
    expect(asked.existing?.agents["dev-bot-mdden"].id).toBe("a-1");
    expect(mints).toBe(1);
    expect(store.held.get("a-1")).toBe("smd_agent_abcdef01_minted");
    expect(store.held.has("a-old")).toBe(false);
    expect(out.join("\n")).toContain("carried over from the deleted agent");
  });

  it("158-S4: an entry configured before and unmarked now has its key forgotten once the write lands", async () => {
    validSession();
    const before = existing();
    before.agents["spec-warden"] = { ...before.agents["dev-bot-mdden"], id: "a-2" };
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(configPath(), serializeConfig(before));
    const store = memoryKeyStore({ "a-1": "smd_agent_aaaaaaaa_kept", "a-2": "smd_agent_bbbbbbbb_left" });
    const { out, context } = io();
    expect(await withFetch(rosterReply, () => runConfigure(deps({ openKeyStore: async () => store }), context))).toBe(0);
    expect(store.held.get("a-1")).toBe("smd_agent_aaaaaaaa_kept");
    expect(store.held.has("a-2")).toBe(false);
    // a-2 is not in the roster this reply returns, so it is gone and nothing is said about its key.
    expect(out.join("\n")).not.toContain("smd_agent_bbbbbbbb");
  });

  it("158-S4: forgetting the key of an agent that still exists names it as still live, and does not revoke it", async () => {
    validSession();
    const before = existing();
    before.agents["spec-warden"] = { ...before.agents["dev-bot-mdden"], id: "a-2" };
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(configPath(), serializeConfig(before));
    const store = memoryKeyStore({ "a-1": "smd_agent_aaaaaaaa_kept", "a-2": "smd_agent_bbbbbbbb_left" });
    const revoked: string[] = [];
    const bothAgents = (url: string) => {
      if (url.includes("rpc/revoke_agent_key")) revoked.push(url);
      return url.includes("/agents")
        ? new Response(
            JSON.stringify([
              { id: "a-1", org_id: "o-1", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-1" },
              { id: "a-2", org_id: "o-1", display_name: "spec-warden", status: "active", bot_user_id: "u-2" },
            ]),
            { status: 200 },
          )
        : rosterReply(url);
    };
    const { out, context } = io();
    expect(await withFetch(bothAgents, () => runConfigure(deps({ openKeyStore: async () => store }), context))).toBe(0);
    expect(store.held.has("a-2")).toBe(false);
    expect(revoked).toEqual([]);
    expect(out.join("\n")).toContain(
      "spec-warden is no longer configured here: the key smd_agent_bbbbbbbb… is still live in markdownbrain.ai; revoke it on the agent's page if nothing else uses it.",
    );
  });

  it("158-S5: a refused mint with a key still held says the key was kept and names the check", async () => {
    validSession();
    const store = memoryKeyStore({ "a-1": "smd_agent_ab12cd34_old" });
    const { out, context } = io();
    context.flags["new-keys"] = true;
    const code = await withFetch(
      (url) =>
        url.includes("rpc/mint_agent_key")
          ? new Response(JSON.stringify({ message: "Agent not found" }), { status: 400, headers: { "content-type": "application/json" } })
          : rosterReply(url),
      () => runConfigure(deps({ openKeyStore: async () => store }), context),
    );
    expect(code).toBe(0);
    const said = out.join("\n");
    expect(said).toContain("smd_agent_ab12cd34…");
    expect(said).toContain("mdbrain agents check dev-bot-mdden");
    expect(said).not.toContain("no connection key");
    expect(store.held.get("a-1")).toBe("smd_agent_ab12cd34_old");
  });

  it("a refused mint whose message echoes the person's bearer is redacted in the summary", async () => {
    validSession();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwZXJzb24ifQ.c2lnbmF0dXJlLXBhcnQ";
    const store = memoryKeyStore({ "a-1": "smd_agent_ab12cd34_old" });
    const { out, context } = io();
    context.flags["new-keys"] = true;
    await withFetch(
      (url) =>
        url.includes("rpc/mint_agent_key")
          ? new Response(JSON.stringify({ message: `bad gateway, request was Authorization: Bearer ${jwt}` }), { status: 502, headers: { "content-type": "application/json" } })
          : rosterReply(url),
      () => runConfigure(deps({ openKeyStore: async () => store }), context),
    );
    const said = out.join("\n");
    expect(said).toContain("the server would not mint a new key");
    expect(said).not.toContain(jwt);
    expect(said).toContain("[redacted]");
  });

  it("177-S17: saving the menu writes the file once and mints the key of the agent it added", async () => {
    validSession();
    const was = existing();
    was.agents["old-bot"] = { ...was.agents["dev-bot-mdden"], id: "a-3" };
    delete was.agents["dev-bot-mdden"];
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(configPath(), serializeConfig(was));
    let asked: ScreenPlan | null = null;
    const { out, context } = io();
    const code = await withFetch(rosterReply, () =>
      runConfigure(
        deps({
          ask: async (plan) => {
            asked = plan;
            return answersFor([["dev-bot-mdden", "a-1"]]);
          },
        }),
        context,
      ),
    );
    expect(code).toBe(0);
    expect((asked as unknown as ScreenPlan).existing).not.toBeNull();
    expect(out.filter((line) => line.startsWith("Configuration written to"))).toHaveLength(1);
    expect(out.join("\n")).toContain("connection key requested from markdownbrain.ai and stored on this machine");
    const written = parseConfig(readFileSync(configPath(), "utf8"));
    expect(written.kind === "config" && Object.keys(written.config.agents)).toEqual(["dev-bot-mdden"]);
  });

  it("177: a menu left with nothing changed writes nothing and exits 0; openAt reaches the screen", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    const text = serializeConfig(existing());
    writeFileSync(configPath(), text);
    let opened: string | undefined;
    const { out, context } = io();
    const code = await withFetch(rosterReply, () =>
      runConfigure(
        deps({
          ask: async (plan) => {
            opened = plan.openAt;
            return "unchanged";
          },
        }),
        context,
        { openAt: "a-1" },
      ),
    );
    expect(code).toBe(0);
    expect(opened).toBe("a-1");
    expect(out.join("\n")).toContain("Nothing changed, so nothing was written.");
    expect(readFileSync(configPath(), "utf8")).toBe(text);
  });
  it("177-S16: changes discarded with y are forgotten, so the next run does not offer them again", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(configPath(), serializeConfig(existing()));
    writeFileSync(draftPath(), JSON.stringify({ version: DRAFT_VERSION, chosen: ["a-1"], dropped: [], agents: {}, sessionsPerHour: 4 }));
    const { err, context } = io();
    const code = await withFetch(rosterReply, () => runConfigure(deps({ ask: async () => "discarded" }), context));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("the changes were left unsaved");
    expect(existsSync(draftPath())).toBe(false);
  });

  it("177: a file still holding old limits, and --new-keys, each count as a change the menu has to save", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    const old = JSON.parse(serializeConfig(existing()));
    old.agents["dev-bot-mdden"].bounds = { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" };
    writeFileSync(configPath(), JSON.stringify(old));
    let pending: number | undefined;
    const { context } = io();
    await withFetch(rosterReply, () =>
      runConfigure(deps({ ask: async (plan) => { pending = plan.pending; return "unchanged"; } }), { ...context, flags: { "new-keys": true } }),
    );
    expect(pending).toBe(2);
  });

  it("177-S21: leaving a menu with nothing changed still mints the key of a configured agent this machine is missing", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    const text = serializeConfig(existing());
    writeFileSync(configPath(), text);
    const store = memoryKeyStore();
    const { out, context } = io();
    const code = await withFetch(rosterReply, () => runConfigure(deps({ openKeyStore: async () => store, ask: async () => "unchanged" }), context));
    expect(code).toBe(0);
    expect(store.held.get("a-1")).toBe("smd_agent_abcdef01_minted");
    expect(out.join("\n")).toContain("Nothing changed, so nothing was written.");
    expect(out.join("\n")).toContain("dev-bot-mdden: connection key requested from markdownbrain.ai and stored on this machine");
    expect(readFileSync(configPath(), "utf8")).toBe(text);
  });

  it("177-S21: leaving a menu with nothing changed keeps a key already held and says nothing about it", async () => {
    validSession();
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(configPath(), serializeConfig(existing()));
    const store = memoryKeyStore({ "a-1": "smd_agent_00000000_held" });
    const { out, context } = io();
    const code = await withFetch(rosterReply, () => runConfigure(deps({ openKeyStore: async () => store, ask: async () => "unchanged" }), context));
    expect(code).toBe(0);
    expect(store.held.get("a-1")).toBe("smd_agent_00000000_held");
    expect(out.join("\n")).not.toContain("connection key");
  });
});
