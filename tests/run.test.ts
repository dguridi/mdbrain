import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  POLL_NOW_MIN_GAP_MS,
  answerPollNow,
  CLAIM_LIMIT,
  placeWork,
  planStartup,
  renamedAgents,
  summaryLines,
  tickPlan,
  type PollNowState,
} from "../src/run/loop.ts";
import { childEnvironment, claudeHarness, harnessFor, type Invocation } from "../src/run/harness.ts";
import { OUTCOME_KINDS, UNREADABLE_OUTCOME_MESSAGE, readOutcome, resultObject, type OutcomeKind, type SessionEnd } from "../src/run/outcome.ts";
import { logRow, rowText } from "../src/run/log.ts";
import { agoText, clockText, costText, dayLine, durationText, plainLine, plainPresenter, shortClaim, type RunEvent } from "../src/run/present.ts";
import type { Config } from "../src/config/schema.ts";

import type { WorkUnit } from "../src/work/instruction.ts";
import {
  MESSAGE_PREVIEW_LIMIT,
  RECENT_LIMIT,
  applyEvent,
  emptyView,
  messagePreview,
  moveSelection,
  selectedRun,
} from "../src/run/view.ts";
import { render } from "ink-testing-library";
import { countdownText, liveScreenFor, liveView, type ScreenFrame } from "../src/run/screen.ts";
import { KEY_BINDINGS, actionForKey, keyHints, type KeyModifiers, type ViewRequest } from "../src/run/keys.ts";

const cwd = process.platform === "win32" ? "C:\\work\\checkout" : "/work/checkout";

/**
 * The live presenter, with the drawing taken out.
 *
 * The keys are the one thing `run` cannot be driven through without a terminal:
 * the plain presenter has no keyboard by design, so the wiring from a keypress
 * to the loop has no other way in. This keeps the presenter contract exactly and
 * records what it was handed, so what is under test is the command's ordering
 * rather than Ink's rendering — which `liveView` is drawn directly to check.
 */
const captured = vi.hoisted(() => ({
  handler: null as ((request: "poll-now" | "quit") => void) | null,
  events: [] as import("../src/run/present.ts").RunEvent[],
}));

vi.mock("../src/run/screen.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/run/screen.ts")>();
  return {
    ...actual,
    livePresenter: () => ({
      present(event: import("../src/run/present.ts").RunEvent) {
        captured.events.push(event);
      },
      listen(handler: (request: "poll-now" | "quit") => void) {
        captured.handler = handler;
      },
      stop: () => Promise.resolve(),
    }),
  };
});

beforeEach(() => {
  captured.handler = null;
  captured.events = [];
});

const entry = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  harness: "claude" as const,
  cwd,
  env: { harness: "ANTHROPIC_API_KEY" as string | null, connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" },
  bounds: { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" },
  ...over,
});

const config = (agents: Record<string, unknown> = { "dev-bot-mdden": entry() }, over: Record<string, unknown> = {}): Config =>
  ({ version: 1, poll: "5m", sessionsPerHour: 10, agents, ...over }) as Config;

const unit = (agent = "dev-bot-mdden", claim = "c1f0", seq = 8412, over: Partial<WorkUnit["instruction"]> = {}): WorkUnit => ({
  kind: "file-arrived",
  seq,
  at: "2026-09-04T01:00:00.000Z",
  instruction: {
    claim,
    workspace: "01-ideas",
    agent,
    prompt: "Triage what landed.",
    file: { id: "9f1e", path: "01-ideas/37-a-doctor-command.md" },
    ...over,
  },
});

const invocation = (over: Partial<Invocation> = {}): Invocation => ({
  prompt: "Triage what landed.",
  claimId: "3f2a0000-0000-4000-8000-000000000000",
  mcpConfigPath: "/cfg/mcp/dev-bot-mdden.json",
  cwd,
  bounds: { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" },
  harnessCredential: "sk-live",
  connectionKeyVariable: "MDBRAIN_KEY_DEV_BOT_MDDEN",
  connectionKey: "smd_agent_deadbeef_secret",
  parentEnv: { PATH: "/usr/bin" },
  ...over,
});

const ending = (over: Partial<SessionEnd> = {}): SessionEnd => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  stopped: false,
  signal: null,
  credentialVariable: "ANTHROPIC_API_KEY",
  ...over,
});

const good = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    is_error: false,
    subtype: "success",
    terminal_reason: "completed",
    result: "Done.",
    session_id: "s-1",
    total_cost_usd: 0.42,
    num_turns: 23,
    duration_ms: 458_000,
    ...over,
  });

// One stamp for every reducer case whose subject is not the clock.
const AT = new Date(2026, 8, 8, 22, 11, 40);

describe("run: startup", () => {
  it("105-S20: an agent whose credential variable is unset, or whose directory is gone, is held by name and the rest continue", () => {
    const plan = planStartup(
      config({ alice: entry({ env: { harness: "A_KEY", connectionKey: "K_A" } }), bob: entry({ env: { harness: "B_KEY", connectionKey: "K_B" } }) }),
      { A_KEY: "x" },
      () => true,
      null,
    );
    expect(plan.asking).toEqual(["alice"]);
    expect(plan.held).toEqual([{ agent: "bob", reason: "B_KEY is not set." }]);

    const gone = planStartup(config({ alice: entry({ cwd }) }), { ANTHROPIC_API_KEY: "x" }, () => false, null);
    expect(gone.asking).toEqual([]);
    expect(gone.held[0].reason).toContain(cwd);
  });

  it("105-S20: an agent using the machine's own account needs no variable and is not held for one", () => {
    const plan = planStartup(config({ alice: entry({ env: { harness: null, connectionKey: "K_A" } }) }), {}, () => true, null);
    expect(plan.asking).toEqual(["alice"]);
    expect(plan.held).toEqual([]);
  });

  it("105-S21: a configured name the roster does not hold is held; the same id under a new name is reported as a rename", () => {
    const held = planStartup(config({ "dev-bot": entry() }), { ANTHROPIC_API_KEY: "x" }, () => true, new Set(["someone-else"]));
    expect(held.asking).toEqual([]);
    expect(held.held[0].reason).toContain("not in the roster");

    const renamed = renamedAgents(config({ "dev-bot": entry({ id: "agent-1" }) }), new Map([["dev-bot-mdden", "agent-1"]]));
    expect(renamed).toEqual([{ configuredAs: "dev-bot", nowCalled: "dev-bot-mdden", id: "agent-1" }]);
  });

  it("105-S22: the summary names the agents asked for, the agents held and why, the ceiling, the poll and the run log", () => {
    const plan = planStartup(
      config({ alice: entry(), bob: entry({ env: { harness: "B_KEY", connectionKey: "K_B" } }) }),
      { ANTHROPIC_API_KEY: "x" },
      () => true,
      null,
    );
    const lines = summaryLines(plan, config(), "/state/runs.jsonl", "  Connection keys are held in the keychain.");
    const text = lines.join("\n");
    expect(text).toContain("Asking for alice.");
    expect(text).toContain("Held: bob — B_KEY is not set.");
    expect(text).toContain("Ceiling: 10 sessions an hour per agent.");
    expect(text).toContain("Polling every 5m.");
    expect(text).toContain("Run log: /state/runs.jsonl");
    expect(text).toContain("Connection keys are held in the keychain.");
  });

  it("105-S22: with no ceiling of its own, the summary says the server's stands", () => {
    const plan = planStartup(config(), { ANTHROPIC_API_KEY: "x" }, () => true, null);
    expect(summaryLines(plan, config(undefined, { sessionsPerHour: null }), "/r", null).join("\n")).toContain(
      "Ceiling: the server's own.",
    );
  });
});

describe("run: the tick", () => {
  it("105-S23: an agent with a session running here is not named in the request", () => {
    const plan = tickPlan(["alice", "bob"], new Set(["bob"]));
    expect(plan.ask).toEqual(["alice"]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toContain("a session is already running");
  });

  it("105-S25: the claim's limit is 1, for the reason the queue exists", () => {
    expect(CLAIM_LIMIT).toBe(1);
  });

  it("105-S28: two units for one agent — one starts, the other waits", () => {
    const placements = placeWork([unit("alice", "c1"), unit("alice", "c2")], new Set(), new Map());
    expect(placements.map((p) => p.action)).toEqual(["start", "queue"]);
    expect(placements[1].depth).toBe(1);
  });

  it("105-S28: an agent already running takes nothing new to start", () => {
    const placements = placeWork([unit("alice", "c1")], new Set(["alice"]), new Map([["alice", 2]]));
    expect(placements[0]).toMatchObject({ action: "queue", depth: 3 });
  });

  it("105-S28: units for different agents each start", () => {
    const placements = placeWork([unit("alice", "c1"), unit("bob", "c2")], new Set(), new Map());
    expect(placements.map((p) => p.action)).toEqual(["start", "start"]);
  });
});

describe("run: the session's invocation", () => {
  it("105-S31: the argv carries the four flags and never --bare", () => {
    const built = claudeHarness.build(invocation());
    expect(built.command).toBe("claude");
    expect(built.args).toContain("--strict-mcp-config");
    expect(built.args.join(" ")).toContain("--permission-mode auto");
    expect(built.args.join(" ")).toContain("--output-format json");
    expect(built.args.join(" ")).toContain("--session-id 3f2a0000-0000-4000-8000-000000000000");
    expect(built.args).not.toContain("--bare");
    expect(built.args).not.toContain("--input-format");
    // The live view changed nothing about what is spawned: `stream-json` stays
    // deferred, so a spinner attests liveness and never progress.
    expect(built.args.join(" ")).not.toContain("stream-json");
  });

  it("105-S87: the argv allows the workspace server the MCP file declares, by the name that file gives it", () => {
    const built = claudeHarness.build(invocation());
    const at = built.args.indexOf("--allowedTools");
    expect(at).toBeGreaterThan(-1);
    expect(built.args[at + 1]).toBe("mcp__markdown-den");

    const declared = Object.keys((JSON.parse(claudeHarness.mcpConfigText("MDBRAIN_KEY_DEV_BOT_MDDEN")) as { mcpServers: Record<string, unknown> }).mcpServers);
    expect(declared).toEqual(["markdown-den"]);
    expect(built.args[at + 1]).toBe(`mcp__${declared[0]}`);
  });

  it("105-S88: the allowance is that one server and nothing else", () => {
    const built = claudeHarness.build(invocation());
    const allowed = built.args.filter((_, i) => built.args[i - 1] === "--allowedTools");
    expect(allowed).toEqual(["mcp__markdown-den"]);
    expect(built.args).not.toContain("--dangerously-skip-permissions");
    expect(built.args).not.toContain("bypassPermissions");
  });

  it("105-S89: the session runs in auto mode, so what it may do is judged rather than pre-listed or unchecked", () => {
    const built = claudeHarness.build(invocation());
    const at = built.args.indexOf("--permission-mode");
    expect(built.args[at + 1]).toBe("auto");
    expect(built.args).not.toContain("acceptEdits");
    expect(built.args).not.toContain("dontAsk");
  });

  it("105-S90: nobody is asked to approve anything, whatever the mode decides", () => {
    const built = claudeHarness.build(invocation());
    const at = built.args.indexOf("--permission-prompts");
    expect(built.args[at + 1]).toBe("none");
    expect(built.args).not.toContain("--permission-prompt-tool");
  });

  it("105-S31: the flags are there whatever the configuration says", () => {
    for (const bounds of [{ maxTurns: 1, maxBudgetUsd: 0.01, wallClock: "1m" }, { maxTurns: 999, maxBudgetUsd: 100, wallClock: "2h" }]) {
      const built = claudeHarness.build(invocation({ bounds }));
      expect(built.args).toContain("--strict-mcp-config");
      expect(built.args).toContain("--mcp-config");
    }
  });

  it("105-S32: -p is the instruction's prompt byte for byte, with nothing before or after it", () => {
    const prompt = "Read 01-ideas/ and reply.\n\n-- not a flag --\n";
    const built = claudeHarness.build(invocation({ prompt }));
    expect(built.args[0]).toBe("-p");
    expect(built.args[1]).toBe(prompt);
  });

  it("105-S33: the child carries the harness's own variable set to the configured value, and the parent is unchanged", () => {
    const parentEnv = { PATH: "/usr/bin", MY_KEY: "sk-from-my-var" };
    const built = claudeHarness.build(invocation({ parentEnv, harnessCredential: parentEnv.MY_KEY }));
    expect(built.env.ANTHROPIC_API_KEY).toBe("sk-from-my-var");
    expect(built.env.MDBRAIN_KEY_DEV_BOT_MDDEN).toBe("smd_agent_deadbeef_secret");
    expect(parentEnv).toEqual({ PATH: "/usr/bin", MY_KEY: "sk-from-my-var" });
  });

  it("105-S44: the machine's own account REMOVES the harness's variable rather than leaving it", () => {
    const built = childEnvironment(
      invocation({ harnessCredential: null, parentEnv: { ANTHROPIC_API_KEY: "sk-left-in-the-shell", PATH: "/usr/bin" } }),
      "ANTHROPIC_API_KEY",
    );
    expect("ANTHROPIC_API_KEY" in built).toBe(false);
    expect(built.PATH).toBe("/usr/bin");
  });

  it("the harness a config entry names is the one that is built", () => {
    expect(harnessFor("claude")).toBe(claudeHarness);
  });
});

describe("run: a session that was refused a tool", () => {
  // Measured on Claude Code 2.1.261: the result object carries
  // `permission_denials` beside `is_error: false`, `subtype: "success"` and
  // `terminal_reason: "completed"`, so every field the harness fills in says the
  // session worked. Four real sessions in the run log on this machine read
  // `done`, exit 0, and cost between $0.10 and $0.25 while doing nothing.
  const denied = (denials: unknown) => readOutcome(ending({ exitCode: 0, stdout: good({ permission_denials: denials }) }));

  it("105-S82: a tool the runner supplied is a failure, though is_error, subtype and terminal_reason all say it succeeded", () => {
    const out = denied([{ tool_name: "mcp__markdown-den__whoami" }]);
    expect(out.kind).toBe("failed");
    expect(out.message).toContain("mcp__markdown-den__whoami");
    expect(out.message).toContain("the runner handed it");
    // The estimate is still recorded: the money was spent and saying otherwise
    // would hide the thing that makes this worth catching.
    expect(out.costUsd).toBe(0.42);
  });

  it("105-S83: an empty list is not a denial, so an ordinary session is untouched", () => {
    expect(denied([]).kind).toBe("done");
    expect(readOutcome(ending({ exitCode: 0, stdout: good() })).kind).toBe("done");
  });

  it("105-S84: a denial it cannot read counts as one of the runner's own", () => {
    // The alternative is reporting a blocked session as a success on the
    // strength of not recognising a field, which is this whole case again.
    for (const shape of [[{}], ["mcp__markdown-den__whoami"], [7], [{ tool: null }]]) {
      expect(denied(shape).kind, JSON.stringify(shape)).toBe("failed");
    }
  });

  it("105-S85: names every distinct tool once, with how many of its calls were declined", () => {
    const out = denied([{ tool_name: "Bash" }, { tool_name: "Bash" }, { tool_name: "Read" }]);
    expect(out.message.match(/Bash/g)).toHaveLength(1);
    expect(out.message).toContain("2 Bash calls");
    expect(out.message).toContain("1 Read call");
    expect(out.message).toContain("were declined");
    // No advice about permissions rules: the result object does not say whether
    // a rule would have helped, and under auto mode the obvious one is dropped.
    expect(out.message).not.toContain("permissions rule");
    expect(out.message).not.toContain("settings of the checkout");
    expect(out.message).not.toContain("configuration says to run");
  });

  it("105-S86: a session that was denied AND reported a failure says both", () => {
    const out = readOutcome(
      ending({ exitCode: 1, stdout: good({ is_error: true, result: "ran out of turns", permission_denials: [{ tool_name: "Bash" }] }) }),
    );
    expect(out.kind).toBe("failed");
    expect(out.message).toContain("Bash");
    expect(out.message).toContain("ran out of turns");
  });

  it("105-S91: one of the harness's own tools is reported after the session's words, and is not a verdict", () => {
    const out = denied([{ tool_name: "Bash" }]);
    expect(out.kind).toBe("done");
    expect(out.message).toContain("Bash");
    expect(out.message).toContain("declined along the way");
    // **The session's own report comes first.** On a run that finished, what the
    // agent says it did is the answer somebody came for; a notice about one
    // declined call put above it stands in front of that answer.
    expect(out.message.startsWith("Done.")).toBe(true);
    expect(out.message.indexOf("Done.")).toBeLessThan(out.message.indexOf("declined"));
  });

  it("105-S91: a session refused nothing carries no note at all", () => {
    expect(readOutcome(ending({ exitCode: 0, stdout: good() })).message).toBe("Done.");
  });

  it("105-S92: refused both kinds, the runner's own is the verdict", () => {
    const out = denied([{ tool_name: "Bash" }, { tool_name: "mcp__markdown-den__whoami" }]);
    expect(out.kind).toBe("failed");
    expect(out.message).toContain("mcp__markdown-den__whoami");
  });

  it("105-S93: refused both kinds, the harness's own are still counted beside the verdict", () => {
    const out = denied([{ tool_name: "Bash" }, { tool_name: "Bash" }, { tool_name: "mcp__markdown-den__whoami" }]);
    expect(out.kind).toBe("failed");
    expect(out.message).toContain("mcp__markdown-den__whoami");
    expect(out.message).toContain("2 Bash calls");
    expect(out.message).toContain("declined along the way");
    // And the counts stay in that note. The verdict names the supplied tool
    // without one, because there the number changes nothing: one refusal of the
    // workspace server ends the session as surely as twenty. Asserted against
    // the literal, since threading a count through the verdict leaves every
    // other case here green.
    expect(out.message).toContain("It needed mcp__markdown-den__whoami, and it was refused");
  });
});

describe("run: the outcome", () => {
  it("105-S35: a result object with is_error true and exit 0 is a failure, in the harness's own words", () => {
    const out = readOutcome(
      ending({
        exitCode: 0,
        stdout: JSON.stringify({
          is_error: true,
          subtype: "success",
          terminal_reason: "api_error",
          api_error_status: 401,
          result: "Failed to authenticate. API Error: 401 API key is invalid.",
        }),
      }),
    );
    expect(out.kind).toBe("failed");
    expect(out.message).toContain("401 API key is invalid");
    // The 401 gets one sentence naming the variable, and nothing else.
    expect(out.message).toContain("ANTHROPIC_API_KEY");
  });

  it("105-S35: `subtype` is not the field — it says success on the failure above", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/run/outcome.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/object\.subtype\s*===/);
  });

  it("105-S35: a 401 for the machine's own account names the account rather than a variable", () => {
    const out = readOutcome(
      ending({
        credentialVariable: null,
        stdout: JSON.stringify({ is_error: true, api_error_status: 401, result: "Failed to authenticate." }),
      }),
    );
    expect(out.message).toContain("this machine's own signed-in account");
  });

  it("105-S36: exit 0 with stdout that is not a result object is unreadable, not done", () => {
    const out = readOutcome(ending({ exitCode: 0, stdout: "all finished!\n" }));
    expect(out.kind).toBe("unreadable");
    expect(out.message).toBe(UNREADABLE_OUTCOME_MESSAGE);
  });

  it("a good run records the harness's estimate, its turns and its own session id", () => {
    const out = readOutcome(ending({ stdout: good() }));
    expect(out).toMatchObject({ kind: "done", sessionId: "s-1", costUsd: 0.42, turns: 23, durationMs: 458_000 });
  });

  it("105-S34: a wall clock that fired is a timeout whatever the output says, and records which signal sufficed", () => {
    const term = readOutcome(ending({ timedOut: true, signal: "term", stdout: good() }));
    expect(term.kind).toBe("timed-out");
    expect(term.message).toContain("was stopped");
    const kill = readOutcome(ending({ timedOut: true, signal: "kill" }));
    expect(kill.message).toContain("killed");
  });

  it("a dirty exit with no result object is a failure whose words are the harness's stderr", () => {
    const out = readOutcome(ending({ exitCode: 127, stdout: "", stderr: "claude: command not found\n" }));
    expect(out).toMatchObject({ kind: "failed", exitCode: 127 });
    expect(out.message).toBe("claude: command not found");
  });

  it("a result object printed after other output is still found", () => {
    expect(resultObject(`warming up\n${good()}\n`)).toMatchObject({ is_error: false });
    expect(resultObject("")).toBeNull();
    expect(resultObject("not json at all")).toBeNull();
  });
});

describe("run: the run log", () => {
  it("105-S38: one row carries the claim, the agent, the workspace, the envelope, the outcome and the cost", () => {
    const outcome = readOutcome(ending({ stdout: good() }));
    const row = logRow(unit(), outcome, new Date("2026-09-04T01:00:00.000Z"), new Date("2026-09-04T01:07:38.000Z"));
    expect(row).toMatchObject({
      claim: "c1f0",
      agent: "dev-bot-mdden",
      workspace: "01-ideas",
      kind: "file-arrived",
      seq: 8412,
      outcome: "done",
      harnessSessionId: "s-1",
      costUsd: 0.42,
    });
    // One object, one newline: a line-delimited file stays one row per session.
    const text = rowText(row);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().includes("\n")).toBe(false);
  });
});

describe("run: the plain presenter", () => {
  const at = new Date(2026, 8, 4, 12, 4, 1);

  it("105-S57: every event is one line, and the label column lines up", () => {
    const events: RunEvent[] = [
      { kind: "poll", agents: ["dev-bot-mdden", "spec-warden"], waiting: 2 },
      { kind: "start", agent: "dev-bot-mdden", claim: "3f2a1111-aaaa", unitKind: "file-arrived", seq: 8412, workspace: "01-ideas" },
      { kind: "skipped", agent: "spec-warden", reason: "spec-warden: a session is already running." },
      { kind: "held", agent: "bob", reason: "B_KEY is not set." },
      { kind: "queued", agent: "dev-bot-mdden", depth: 1 },
      { kind: "done", agent: "dev-bot-mdden", claim: "3f2a1111-aaaa", ms: 458_000, costUsd: 0.42, turns: 23, message: "Done." },
      { kind: "failed", agent: "dev-bot-mdden", claim: "9c011111-bbbb", outcome: "failed", ms: 1000, message: "no credential" },
      { kind: "stopped", lostQueued: 2 },
    ];
    const lines = events.map((event) => plainLine({ at, event }));
    for (const line of lines) {
      expect(line).not.toBeNull();
      expect(line!.startsWith("12:04:01 ")).toBe(true);
      expect(line!.includes("\n")).toBe(false);
    }
    const texts = lines.map((l) => l!.slice("12:04:01 ".length));
    // The label column is one width, so the text starts in the same place.
    expect(new Set(texts.map((t) => t.length - t.trimStart().length === 0))).toEqual(new Set([true]));
    expect(lines[0]).toContain("poll      asked for dev-bot-mdden, spec-warden — 2 waiting");
    expect(lines[1]).toContain("start     dev-bot-mdden  claim 3f2a…  file-arrived #8412  01-ideas");
    expect(lines[5]).toContain("done      dev-bot-mdden  claim 3f2a…  7m38s  $0.42  turns 23");
    expect(lines[7]).toContain("stopped   2 queued units lost");
  });

  it("a presenter writes one line per event and decides nothing", () => {
    const written: string[] = [];
    const presenter = plainPresenter((line) => written.push(line), () => at);
    presenter.present({ kind: "note", message: "the network was unreachable" });
    expect(written).toEqual(["12:04:01 note      the network was unreachable"]);
  });

  it("a cost the harness did not report is a dash rather than zero", () => {
    expect(costText(null)).toBe("—");
    expect(costText(0)).toBe("$0.00");
    expect(durationText(458_000)).toBe("7m38s");
    expect(durationText(41_000)).toBe("41s");
    expect(durationText(3_720_000)).toBe("1h02m");
    expect(shortClaim("3f2a1111-2222")).toBe("3f2a…");
  });
});

describe("run: what the module may not reach", () => {
  it("the tick, the invocation, the outcome and the queue are pure — no file, socket or process in any of them", () => {
    for (const file of ["loop.ts", "harness.ts", "outcome.ts", "present.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`../src/run/${file}`, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/^import .*(node:fs|node:child_process|node:net|node:http)/m);
    }
  });

  it("the runner never reads the brain's own configuration", () => {
    for (const file of ["loop.ts", "harness.ts", "outcome.ts", "present.ts", "view.ts", "execute.ts", "log.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`../src/run/${file}`, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/brain-config/);
    }
  });
});

describe("run: spawning", () => {
  it("105-S39: a failure to spawn is an outcome, never a throw", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const ended = await runSession(
      {
        spawnable: { command: "definitely-not-a-real-command-mdbrain", args: [], env: {} },
        cwd: process.cwd(),
        wallClockMs: 5_000,
      },
      { spawn: (await import("node:child_process")).spawn, isWindows: process.platform === "win32" },
    );
    expect(ended.spawnProblem).not.toBeNull();
    expect(ended.timedOut).toBe(false);
  });

  it("105-S34: a session that outlives its wall clock is signalled and reported as timed out", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { spawn } = await import("node:child_process");
    const ended = await runSession(
      {
        spawnable: {
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 60000)"],
          env: { PATH: process.env.PATH ?? "" },
        },
        cwd: process.cwd(),
        wallClockMs: 150,
        graceMs: 50,
      },
      { spawn, isWindows: process.platform === "win32" },
    );
    expect(ended.timedOut).toBe(true);
    expect(ended.signal).not.toBeNull();
  }, 20_000);

  it("stdout is captured whole, since the result object is one object at the end of it", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { spawn } = await import("node:child_process");
    const ended = await runSession(
      {
        spawnable: {
          command: process.execPath,
          args: ["-e", `process.stdout.write(${JSON.stringify(good())})`],
          env: { PATH: process.env.PATH ?? "" },
        },
        cwd: process.cwd(),
        wallClockMs: 10_000,
      },
      { spawn, isWindows: process.platform === "win32" },
    );
    expect(ended.exitCode).toBe(0);
    expect(readOutcome(ending({ stdout: ended.stdout })).kind).toBe("done");
  }, 20_000);
});

describe("run: the registry and the poll timer", () => {
  it("the registry carries `run` with its one flag, so `--help` shows it", async () => {
    const { COMMANDS } = await import("../src/main.ts");
    const spec = COMMANDS.find((c) => c.name === "run");
    expect(spec).toBeDefined();
    expect(spec?.flags?.map((f) => f.name)).toEqual(["once"]);
    expect(spec?.summary).not.toBe("");
  });

  it("the poll can be cut short by a stop rather than waiting it out", async () => {
    const { waitFor } = await import("../src/commands/run.ts");
    const signal = { stopped: false, wake: null as (() => void) | null };
    const waiting = waitFor(60_000, signal);
    // The wake is what SIGINT calls; without it a Ctrl-C would sit through the
    // rest of a five-minute poll before anything happened.
    expect(signal.wake).not.toBeNull();
    signal.wake?.();
    await expect(waiting).resolves.toBeUndefined();
    await expect(waitFor(60_000, { stopped: true, wake: null })).resolves.toBeUndefined();
  });

});


/** A `run` driven with every edge stood in for: no disk, no socket, no process, no terminal. */
async function drive(over: Partial<import("../src/commands/run.ts").RunDeps> = {}, flags: Record<string, unknown> = {}) {
  const { runRun } = await import("../src/commands/run.ts");
  const out: string[] = [];
  const err: string[] = [];
  const rows: unknown[] = [];
  const notes: import("../src/run/diagnosis.ts").DiagnosisRow[] = [];
  const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const deps: import("../src/commands/run.ts").RunDeps = {
    isTTY: false,
    env: { ANTHROPIC_API_KEY: "sk-live" },
    directoryExists: () => true,
    openKeyStore: async () => ({
      backend: { kind: "keychain", where: "the keychain" },
      get: async () => "smd_agent_deadbeef_secret",
      set: async () => {},
      forget: async () => {},
    }),
    loadConfiguration: async () => ({ kind: "config", config: config() }),
    session: async () => ({ kind: "ready", accessToken: "token" }),
    roster: async () => [{ id: "agent-1", org_id: "o", display_name: "dev-bot-mdden", status: "active" }],
    count: async () => ({ waiting: 1, capped: false }),
    claim: async () => ({ work: [unit()], refused: [] }),
    startSession: async (request) => {
      spawned.push(request.spawnable);
      return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stopped: false, signal: null, spawnProblem: null };
    },
    recordRun: async (row) => {
      rows.push(row);
    },
    recordDiagnosis: async (row) => {
      notes.push(row);
    },
    sleep: async () => {},
    now: () => new Date(2026, 8, 4, 12, 4, 1),
    lookupLatest: async () => null,
    build: { version: "0.1.0", channel: "direct", isCompiled: true },
    ...over,
  };
  const code = await runRun(deps, { positional: [], flags: { once: true, ...flags }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, rows, notes, spawned };
}

describe("run: the command, driven end to end", () => {
  it("105-S19: no config names `mdbrain configure`; no session names `mdbrain login` and opens no browser", async () => {
    const { noConfigMessage } = await import("../src/commands/run.ts");
    expect(noConfigMessage("/cfg/config.json")).toContain("mdbrain configure");

    const none = await drive({ loadConfiguration: async () => ({ kind: "none" }) });
    expect(none.code).toBe(1);
    expect(none.err.join("\n")).toContain("mdbrain configure");

    const signedOut = await drive({
      session: async () => ({ kind: "stop", reason: "sign-in", message: "Sign in with `mdbrain login`." }),
    });
    expect(signedOut.code).toBe(1);
    expect(signedOut.err.join("\n")).toContain("mdbrain login");

    // Stronger than "it did not open one": the command does not import the login.
    const source = readFileSync(fileURLToPath(new URL("../src/commands/run.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from "\.\/login\.ts"/);
  });

  it("105-S20: every configured agent held is a refusal, not a runner asking for nobody", async () => {
    const { ALL_HELD_MESSAGE } = await import("../src/commands/run.ts");
    const held = await drive({ env: {}, roster: async () => [] });
    expect(held.code).toBe(1);
    expect(held.err.join("\n")).toBe(ALL_HELD_MESSAGE);
  });

  it("105-S24: a counter that answers zero makes no claim that tick", async () => {
    const claim = vi.fn(async () => ({ work: [], refused: [] }));
    const zero = await drive({ count: async () => ({ waiting: 0, capped: false }), claim });
    expect(claim).not.toHaveBeenCalled();
    expect(zero.out.join("\n")).toContain("0 waiting");
  });

  it("105-S25: the claim carries limit 1 and the configured ceiling", async () => {
    const claim = vi.fn(async () => ({ work: [], refused: [] }));
    await drive({ claim });
    expect(claim).toHaveBeenCalledWith("token", ["dev-bot-mdden"], 1, 10);

    const noCeiling = vi.fn(async () => ({ work: [], refused: [] }));
    await drive({
      claim: noCeiling,
      loadConfiguration: async () => ({ kind: "config", config: config(undefined, { sessionsPerHour: null }) }),
    });
    expect(noCeiling).toHaveBeenCalledWith("token", ["dev-bot-mdden"], 1, null);
  });

  it("105-S26: an unreadable answer prints its one sentence and starts nothing", async () => {
    const startSession = vi.fn();
    const bad = await drive({ claim: async () => ({ work: [{ nonsense: true }] }), startSession });
    expect(startSession).not.toHaveBeenCalled();
    expect(bad.out.join("\n")).toContain("this version of mdbrain can read");
    expect(bad.code).toBe(0);
  });

  it("105-S27: each refusal is printed as the server worded it, once", async () => {
    const reason = "dev-bot-mdden: 3 units of work held back, the runner's ceiling is spent.";
    const refused = await drive({
      claim: async () => ({
        work: [],
        refused: [{ agent: "dev-bot-mdden", workspace: "w", by: "runner", heldBack: 3, reason }],
      }),
    });
    expect(refused.out.filter((l) => l.includes(reason))).toHaveLength(1);
  });

  it("105-S29: a request that never reached an answer is one line and the tick goes on", async () => {
    const unreachable = await drive({
      count: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(unreachable.code).toBe(0);
    expect(unreachable.out.join("\n")).toContain("socket hang up");
  });

  it("105-S37: a failed outcome starts no second session for that unit — the claim is spent", async () => {
    const startSession = vi.fn(async () => ({
      stdout: JSON.stringify({ is_error: true, result: "it went wrong" }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
      stopped: false,
      signal: null,
      spawnProblem: null,
    }));
    const failed = await drive({ startSession });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(failed.out.join("\n")).toContain("it went wrong");
    // Recorded once, with the outcome it actually had.
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]).toMatchObject({ outcome: "failed", claim: "c1f0" });
  });

  it("105-S38: a finished session appends exactly one row", async () => {
    const done = await drive();
    expect(done.rows).toHaveLength(1);
    expect(done.rows[0]).toMatchObject({ outcome: "done", agent: "dev-bot-mdden", workspace: "01-ideas" });
    expect(done.out.join("\n")).toContain("done      dev-bot-mdden");
  });

  it("105-S39: a spawn that never started is an outcome, and the agent is asked for work again", async () => {
    let asked = 0;
    const spawnFailed = await drive({
      count: async () => {
        asked += 1;
        return { waiting: 1, capped: false };
      },
      startSession: async () => ({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        stopped: false,
        signal: null,
        spawnProblem: "spawn claude ENOENT",
      }),
    });
    expect(spawnFailed.out.join("\n")).toContain("spawn claude ENOENT");
    expect(spawnFailed.rows[0]).toMatchObject({ outcome: "spawn-failed" });
    expect(asked).toBe(1);
  });

  it("105-S78: the prompt reaches the harness with the triggering file substituted into it", async () => {
    const started = await drive({
      claim: async () => ({
        work: [unit("dev-bot-mdden", "c1f0", 8412, { prompt: "Read {path} (id {id}) and triage it." })],
        refused: [],
      }),
    });
    const args = started.spawned[0].args;
    expect(args[args.indexOf("-p") + 1]).toBe("Read 01-ideas/37-a-doctor-command.md (id 9f1e) and triage it.");
  });

  it("105-S79: a prompt with an unrecognised placeholder starts no session and spends no money", async () => {
    let sessions = 0;
    const typo = await drive({
      claim: async () => ({
        work: [unit("dev-bot-mdden", "c1f0", 8412, { prompt: "Read {paht} and triage it." })],
        refused: [],
      }),
      startSession: async () => {
        sessions += 1;
        throw new Error("a session must not be started for a prompt that could not be rendered");
      },
    });
    // The whole point: the harness is never reached, so nothing is paid for.
    expect(sessions).toBe(0);
    expect(typo.rows[0]).toMatchObject({ outcome: "spawn-failed", costUsd: null });
    expect(String((typo.rows[0] as { message: string }).message)).toContain("{paht}");
    expect(typo.out.join("\n")).toContain("{paht}");
  });

  it("105-S41: `--once` runs one tick, waits for its sessions, and exits 1 only if one failed", async () => {
    expect((await drive()).code).toBe(0);
    const failed = await drive({
      startSession: async () => ({
        stdout: JSON.stringify({ is_error: true, result: "no" }),
        stderr: "",
        exitCode: 1,
        timedOut: false,
        stopped: false,
        signal: null,
        spawnProblem: null,
      }),
    });
    expect(failed.code).toBe(1);
    // Waited for: the row is there before the command returned.
    expect(failed.rows).toHaveLength(1);
  });

  it("105-S40: the last line says how many queued units were lost", async () => {
    const busy = await drive({ claim: async () => ({ work: [unit("dev-bot-mdden", "c1"), unit("dev-bot-mdden", "c2")], refused: [] }) });
    // Both ran — the second started when the first ended — so nothing was lost.
    expect(busy.rows).toHaveLength(2);
    expect(busy.out.join("\n")).toContain("stopped   nothing was queued");
    expect(busy.out.join("\n")).toContain("queued    dev-bot-mdden  1 waiting");
  });

  it("a session without a connection key on this machine is an outcome naming `configure`", async () => {
    const noKey = await drive({
      openKeyStore: async () => ({
        backend: { kind: "file", where: "/state/secrets.json", reason: "there is no keychain" },
        get: async () => null,
        set: async () => {},
        forget: async () => {},
      }),
    });
    expect(noKey.out.join("\n")).toContain("mdbrain configure");
    expect(noKey.rows[0]).toMatchObject({ outcome: "spawn-failed" });
  });

  it("what is spawned is what the harness built, with the connection key in the child", async () => {
    const spawned = await drive();
    expect(spawned.spawned[0].command).toBe("claude");
    expect(spawned.spawned[0].args).toContain("--strict-mcp-config");
    expect(spawned.spawned[0].env.MDBRAIN_KEY_DEV_BOT_MDDEN).toBe("smd_agent_deadbeef_secret");
  });

  it("105-S30: `run` names no endpoint that stamps a check-in", () => {
    // The first caller that could stamp one by accident. The two routes it
    // reaches are the count and the claim, and neither resolves an agent
    // session; nothing here touches an agent row at all.
    const source = readFileSync(fileURLToPath(new URL("../src/commands/run.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/last_checkin_at|check_in|checkin/);
    const api = readFileSync(fileURLToPath(new URL("../src/auth/api.ts", import.meta.url)), "utf8");
    expect(api).not.toMatch(/last_checkin_at/);
  });
});

describe("run: the live view", () => {
  /** A fixed moment, so the countdown a test reads is arithmetic rather than timing. */
  const NOW = new Date(2026, 8, 4, 12, 4, 1).getTime();
  const frame = (over: Partial<ScreenFrame> = {}): ScreenFrame => ({ now: NOW, keysActive: true, selection: null, ...over });
  const feed = (events: RunEvent[]) => events.reduce((state, event) => applyEvent(state, event, AT), emptyView);

  it("105-S54: an agent idle, then running, then idle again reflects each transition", () => {
    const idle = feed([{ kind: "configured", agent: "dev-bot-mdden" }]);
    expect(idle.agents).toEqual([{ agent: "dev-bot-mdden", state: "idle", note: null, queued: 0 }]);

    const running = applyEvent(idle, {
      kind: "start",
      agent: "dev-bot-mdden",
      claim: "c1",
      unitKind: "file-arrived",
      seq: 8412,
      workspace: "01-ideas",
    }, AT);
    expect(running.agents[0]).toMatchObject({ state: "running", note: "file-arrived #8412 · 01-ideas" });

    const back = applyEvent(running, { kind: "done", agent: "dev-bot-mdden", claim: "c1", ms: 1000, costUsd: 1, turns: 2, message: "Done." }, AT);
    expect(back.agents[0]).toMatchObject({ state: "idle", note: null });

    // Drawn rather than only held: the running row is the one that mounts the
    // spinner, so this is the only place anything renders one.
    const drawn = render(liveView(running, frame())).lastFrame() ?? "";
    expect(drawn).toContain("dev-bot-mdden");
    expect(drawn).toContain("file-arrived #8412 · 01-ideas");
  });

  it("105-S54: every value on screen comes from an event — the view has no clock and no state of its own", () => {
    // `applyEvent` is pure and total: the same events give the same screen, and
    // nothing but an event can move a value. The spinner's frame is the one
    // thing that is timer-driven, and it is Ink's rather than this state's.
    const events: RunEvent[] = [
      { kind: "configured", agent: "a" },
      { kind: "start", agent: "a", claim: "c", unitKind: "k", seq: 1, workspace: "w" },
      { kind: "done", agent: "a", claim: "c", ms: 5, costUsd: null, turns: null, message: "Done." },
    ];
    expect(feed(events)).toEqual(feed(events));

    const source = readFileSync(fileURLToPath(new URL("../src/run/view.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/setInterval|setTimeout|Date\.now/);
  });

  it("105-S55: an agent held at startup is drawn as held, not left out", () => {
    const view = feed([
      { kind: "configured", agent: "alice" },
      { kind: "held", agent: "bob", reason: "B_KEY is not set." },
    ]);
    expect(view.agents.map((a) => a.agent)).toEqual(["alice", "bob"]);
    expect(view.agents[1]).toMatchObject({ state: "held", note: "B_KEY is not set." });

    // The scenario's word is *drawn*. Asserting the state and then that the
    // element exists cannot see a roster that draws held rows as nothing.
    const drawn = render(liveView(view, frame())).lastFrame() ?? "";
    expect(drawn).toContain("alice");
    expect(drawn).toContain("bob");
    expect(drawn).toContain("held — B_KEY is not set.");
  });

  it("105-S56: the recent-runs list starts empty, holds finished sessions newest first, and survives nothing", () => {
    expect(emptyView.recent).toEqual([]);

    const view = feed([
      { kind: "configured", agent: "a" },
      { kind: "done", agent: "a", claim: "c1", ms: 1000, costUsd: 0.1, turns: 1, message: "Done." },
      { kind: "failed", agent: "a", claim: "c2", outcome: "timed-out", ms: 2000, message: "over its wall clock" },
    ]);
    expect(view.recent.map((r) => r.outcome)).toEqual(["timed-out", "done"]);

    // Bounded, because it is memory that a long-running process holds.
    const many = feed([
      { kind: "configured", agent: "a" },
      ...Array.from({ length: RECENT_LIMIT + 4 }, (_, i): RunEvent => ({ kind: "done", agent: "a", claim: `c${i}`, ms: i, costUsd: null, turns: null, message: `run ${i}` })),
    ]);
    expect(many.recent).toHaveLength(RECENT_LIMIT);

    // And it is never read back off disk. Asserted against what the module can
    // reach rather than against the words in it: the header says `runs.jsonl` in
    // order to explain that it never reads it, so a search for the name would
    // fail on the comment that states the property.
    const source = readFileSync(fileURLToPath(new URL("../src/run/view.ts", import.meta.url)), "utf8");
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports.some((line) => /node:fs|\/log\.ts/.test(line))).toBe(false);
    expect(source).not.toMatch(/\b(readFile|readFileSync|appendRun|runLogPath)\s*\(/);
  });

  it("105-S57: without a TTY the output is the plain lines and no view is constructed", async () => {
    const plain = await drive({ isTTY: false });
    // Every line is a plain line: stamped, single-line, and with a known label.
    for (const line of plain.out.filter((l) => !l.startsWith("mdbrain run") && !l.startsWith("  "))) {
      expect(line).toMatch(/^\d\d:\d\d:\d\d [a-z]+ {2,}/);
    }
    const source = readFileSync(fileURLToPath(new URL("../src/commands/run.ts", import.meta.url)), "utf8");
    // The choice is the TTY check and nothing else, made once.
    expect(source).toMatch(/deps\.isTTY \? livePresenter\(/);
  });

  it("105-S58: with nothing running the whole roster is still drawn, reading idle", () => {
    const view = feed([{ kind: "configured", agent: "alice" }, { kind: "configured", agent: "bob" }]);
    expect(view.agents.every((a) => a.state === "idle")).toBe(true);

    // A row per agent, each reading idle, in the frame. This is the state the
    // roster spends most of its life in, and drawing nothing for it is exactly
    // what makes a long-running process look like a shell handed back.
    const drawn = render(liveView(view, frame())).lastFrame() ?? "";
    expect(drawn).toContain("alice");
    expect(drawn).toContain("bob");
    expect(drawn.match(/idle/g) ?? []).toHaveLength(2);
    // And with no agents at all it draws a roster saying so rather than nothing.
    expect(render(liveView(emptyView, frame())).lastFrame() ?? "").toContain("(none configured)");
  });

  it("105-S59: the same events give both presenters the same facts — the presenter is chosen after the tick decided", () => {
    const events: RunEvent[] = [
      { kind: "configured", agent: "dev-bot-mdden" },
      { kind: "poll", agents: ["dev-bot-mdden"], waiting: 1 },
      { kind: "start", agent: "dev-bot-mdden", claim: "c1", unitKind: "file-arrived", seq: 1, workspace: "w" },
      { kind: "done", agent: "dev-bot-mdden", claim: "c1", ms: 1000, costUsd: 0.5, turns: 3, message: "Done." },
    ];
    const printed: string[] = [];
    const presenter = plainPresenter((l) => printed.push(l), () => new Date(2026, 8, 4, 12, 4, 1));
    for (const event of events) presenter.present(event);
    const view = feed(events);

    // The plain lines say a session ran and ended; the view says the same agent
    // is idle again with that run in its list. Neither presenter added a fact.
    expect(printed.some((l) => l.includes("start"))).toBe(true);
    expect(printed.some((l) => l.includes("done"))).toBe(true);
    expect(view.agents[0]).toMatchObject({ agent: "dev-bot-mdden", state: "idle" });
    expect(view.recent).toHaveLength(1);
  });

  it("a queued unit shows depth, and finishing one takes it back down", () => {
    const queued = feed([
      { kind: "configured", agent: "a" },
      { kind: "start", agent: "a", claim: "c1", unitKind: "k", seq: 1, workspace: "w" },
      { kind: "queued", agent: "a", depth: 2 },
    ]);
    expect(queued.agents[0]).toMatchObject({ state: "running", queued: 2 });
    const after = applyEvent(queued, { kind: "done", agent: "a", claim: "c1", ms: 1, costUsd: null, turns: null, message: "Done." }, AT);
    expect(after.agents[0].queued).toBe(1);
  });

  it("a tick-level skip changes nothing: the agent is already running, which is that fact said usefully", () => {
    const before = feed([
      { kind: "configured", agent: "a" },
      { kind: "start", agent: "a", claim: "c", unitKind: "k", seq: 1, workspace: "w" },
    ]);
    expect(applyEvent(before, { kind: "skipped", agent: "a", reason: "a: a session is already running." }, AT)).toBe(before);
  });
});

describe("run: what the review found", () => {
  it("a session the runner stopped is its own outcome, not a failure and not a timeout", () => {
    const term = readOutcome(ending({ stopped: true, signal: "term" }));
    expect(term.kind).toBe("stopped");
    expect(term.message).toContain("stopped before it finished");
    expect(readOutcome(ending({ stopped: true, signal: "kill" })).message).toContain("killed");
    // A wall clock that fired wins: it is the more specific fact.
    expect(readOutcome(ending({ stopped: true, timedOut: true, signal: "term" })).kind).toBe("timed-out");
  });

  it("105-S29: a refused session ends `run` with spec 96's sentence rather than being retried forever", async () => {
    const { AuthError } = await import("../src/auth/api.ts");
    let polls = 0;
    const refused = await drive(
      {
        count: async () => {
          polls += 1;
          throw new AuthError(401, "JWT expired");
        },
        // Not `--once`: the point is that the loop ends on its own.
        sleep: async () => {},
      },
      { once: false },
    );
    expect(polls).toBe(1);
    expect(refused.code).toBe(1);
    expect(refused.err.join("\n")).toMatch(/mdbrain login/);
    // And it is not reported as a network blip, which is the mistake that hides
    // a revocation behind a sentence about the network.
    expect(refused.out.join("\n")).not.toContain("could not be read");
  });

  it("105-S29: the session is produced per tick, so an expiring token is refreshed rather than fatal", async () => {
    let reads = 0;
    let polls = 0;
    await drive(
      {
        session: async () => {
          reads += 1;
          return { kind: "ready", accessToken: `token-${reads}` };
        },
        count: async (token) => {
          polls += 1;
          // The tick used the token this tick's read produced, not startup's.
          expect(token).toBe(`token-${reads}`);
          return { waiting: 0, capped: false };
        },
      },
      { once: true },
    );
    // Once at startup to refuse a signed-out runner, once for the tick's token.
    expect(reads).toBe(2);
    expect(polls).toBe(1);
  });

  it("105-S29: a session that ends mid-run stops the loop and says so", async () => {
    let reads = 0;
    const ended = await drive(
      {
        session: async () => {
          reads += 1;
          return reads === 1
            ? { kind: "ready", accessToken: "t" }
            : { kind: "stop", reason: "refreshed-away", message: "That session has ended. Sign in again with `mdbrain login`." };
        },
        sleep: async () => {},
      },
      { once: false },
    );
    expect(ended.code).toBe(1);
    expect(ended.err.join("\n")).toContain("mdbrain login");
  });

  it("105-S40: stopping asks every running session to stop rather than waiting out its wall clock", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { spawn } = await import("node:child_process");
    const stoppers = new Set<() => void>();
    const running = runSession(
      {
        spawnable: {
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 60000)"],
          env: { PATH: process.env.PATH ?? "" },
        },
        cwd: process.cwd(),
        // Thirty minutes, as a real config has: without the stop below this
        // test would sit here for all of it, which is the defect.
        wallClockMs: 30 * 60_000,
        graceMs: 50,
        onStop: (stopper) => {
          stoppers.add(stopper);
          return () => stoppers.delete(stopper);
        },
      },
      { spawn, isWindows: process.platform === "win32" },
    );
    for (const stopper of [...stoppers]) stopper();
    const ended = await running;
    expect(ended.stopped).toBe(true);
    expect(ended.timedOut).toBe(false);
    expect(ended.signal).not.toBeNull();
    // Unregistered on settle, so a stopped session leaves nothing behind.
    expect(stoppers.size).toBe(0);
  }, 20_000);

  it("stdout is decoded once, so a multibyte character split across chunks survives", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { spawn } = await import("node:child_process");
    // A long run of em dashes: three bytes each, far past one chunk, so a
    // boundary lands inside a character with near certainty.
    const script = `const s = "—".repeat(60000); process.stdout.write(JSON.stringify({ is_error: false, result: s }));`;
    const ended = await runSession(
      {
        spawnable: { command: process.execPath, args: ["-e", script], env: { PATH: process.env.PATH ?? "" } },
        cwd: process.cwd(),
        wallClockMs: 15_000,
      },
      { spawn, isWindows: process.platform === "win32" },
    );
    expect(ended.stdout).not.toContain("\uFFFD");
    const outcome = readOutcome(ending({ stdout: ended.stdout }));
    expect(outcome.kind).toBe("done");
    expect(outcome.message).toBe("—".repeat(60000));
  }, 25_000);

  it("the connection key survives when its variable is the harness's own, and the pair is refused anyway", async () => {
    const { credentialsCollide } = await import("../src/run/harness.ts");
    expect(credentialsCollide(claudeHarness, "ANTHROPIC_API_KEY")).toBe(true);
    expect(credentialsCollide(claudeHarness, "MDBRAIN_KEY_X")).toBe(false);

    // The ordering is the second lock: even built, the key is not deleted.
    const env = childEnvironment(
      invocation({ harnessCredential: null, connectionKeyVariable: "ANTHROPIC_API_KEY", parentEnv: {} }),
      "ANTHROPIC_API_KEY",
    );
    expect(env.ANTHROPIC_API_KEY).toBe("smd_agent_deadbeef_secret");

    // And the command refuses the configuration rather than running it.
    const collided = await drive({
      loadConfiguration: async () => ({
        kind: "config",
        config: config({ "dev-bot-mdden": entry({ env: { harness: null, connectionKey: "ANTHROPIC_API_KEY" } }) }),
      }),
    });
    expect(collided.out.join("\n")).toContain("One variable cannot hold both");
    expect(collided.rows[0]).toMatchObject({ outcome: "spawn-failed" });
  });

  it("a session that throws while being drawn does not take the runner down with it", async () => {
    // The presenter is reached from inside `startUnit`; a throw there used to
    // become an unhandled rejection, which on this Node ends the process.
    let thrown = 0;
    const survived = await drive({
      recordRun: async () => {
        thrown += 1;
        throw new Error("the log is on a full disk");
      },
    });
    expect(thrown).toBe(1);
    // Reported as a note and the run still finished cleanly.
    expect(survived.out.join("\n")).toContain("full disk");
    expect(survived.code).toBe(0);
  });
});

describe("run: the origin the app is reached at", () => {
  it("APP_URL carries `www.`, because the apex redirects and a redirect drops the credential", async () => {
    const { APP_URL } = await import("../src/auth/project.ts");
    // Measured against production: https://markdown-den.com/api/events/count
    // answers 308 to https://www.markdown-den.com/api/events/count, and fetch
    // strips Authorization across that hop — so the route sees no bearer and
    // refuses a perfectly good token as though the person were signed out.
    expect(APP_URL).toBe("https://www.markdown-den.com");
  });

  it("a redirect on an app call is reported as a wrong address, never as a refused session", async () => {
    const { askForCount, claimWork, AuthError } = await import("../src/auth/api.ts");
    const { signInAgainMessage } = await import("../src/auth/session.ts");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 308, headers: { location: "https://elsewhere.example/api/events/count" } })) as typeof fetch;
    try {
      for (const call of [() => askForCount("t", ["a"]), () => claimWork("t", ["a"], 1, null)]) {
        await expect(call()).rejects.toThrow(/redirected to/);
        const cause = await call().catch((e: unknown) => e);
        expect(cause).toBeInstanceOf(AuthError);
        // Status 0, so it is never mistaken for the session being over: the
        // runner must not tell somebody to sign in again over a bad address.
        expect((cause as InstanceType<typeof AuthError>).status).toBe(0);
        expect(signInAgainMessage((cause as InstanceType<typeof AuthError>).status)).toBeNull();
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("run: the countdown and the keys", () => {
  const NOW = new Date(2026, 8, 4, 12, 4, 1).getTime();
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
  };
  const frame = (over: Partial<ScreenFrame> = {}): ScreenFrame => ({ now: NOW, keysActive: true, selection: null, ...over });
  const feed = (events: RunEvent[]) => events.reduce((state, event) => applyEvent(state, event, AT), emptyView);
  const press = (over: Partial<KeyModifiers> = {}): KeyModifiers => ({ ctrl: false, upArrow: false, downArrow: false, escape: false, ...over });

  it("105-S60: the deadline arrives as an event, and the only thing the clock supplies is the subtraction", () => {
    const waiting = feed([
      { kind: "configured", agent: "a" },
      { kind: "phase", phase: { kind: "waiting", at: NOW + 252_000 } },
    ]);
    expect(waiting.poll).toEqual({ kind: "waiting", at: NOW + 252_000 });
    expect(countdownText(waiting, NOW)).toBe("next poll in 4m12s");
    expect(countdownText(waiting, NOW + 251_000)).toBe("next poll in 1s");
    // A deadline the clock has already passed is a poll about to happen, not a
    // negative number: the loop is one turn away and the arithmetic is rounding.
    expect(countdownText(waiting, NOW + 300_000)).toBe("next poll due now");

    expect(countdownText(applyEvent(waiting, { kind: "phase", phase: { kind: "polling" } }, AT), NOW)).toBe("polling now");
    // A runner that has not said where it is says nothing rather than guessing.
    expect(countdownText(emptyView, NOW)).toBeNull();
    expect(render(liveView(waiting, frame())).lastFrame()).toContain("next poll in 4m12s");
  });

  it("105-S71: a runner that will not poll again stops counting down to a poll", () => {
    // The countdown through a shutdown, or through the whole of a `--once` run
    // waiting on its sessions, would count down to a poll that never comes —
    // which is the one kind of lie a screen like this can tell.
    const finishing = feed([
      { kind: "configured", agent: "a" },
      { kind: "phase", phase: { kind: "waiting", at: NOW + 252_000 } },
      { kind: "phase", phase: { kind: "finishing" } },
    ]);
    expect(finishing.poll).toEqual({ kind: "finishing" });
    expect(countdownText(finishing, NOW)).toBe("no more polls — waiting for the sessions that are running");
    expect(render(liveView(finishing, frame())).lastFrame()).not.toContain("next poll in");
  });

  it("105-S60: a countdown is a screen's business and never a plain line", () => {
    const at = new Date(2026, 8, 4, 12, 4, 1);
    expect(plainLine({ at, event: { kind: "phase", phase: { kind: "waiting", at: NOW + 60_000 } } })).toBeNull();
    expect(plainLine({ at, event: { kind: "phase", phase: { kind: "polling" } } })).toBeNull();
    expect(plainLine({ at, event: { kind: "phase", phase: { kind: "finishing" } } })).toBeNull();
    const written: string[] = [];
    const presenter = plainPresenter((line) => written.push(line), () => at);
    presenter.present({ kind: "phase", phase: { kind: "waiting", at: NOW + 60_000 } });
    expect(written).toEqual([]);
  });

  it("105-S62: a poll asked for while one is in flight, or twice over, is refused in words rather than dropped", () => {
    const where = (over: Partial<PollNowState> = {}): PollNowState => ({ polling: false, finishing: false, lastTakenAt: null, ...over });
    expect(answerPollNow(NOW, where())).toEqual({ kind: "taken", reason: null });

    const inFlight = answerPollNow(NOW, where({ polling: true }));
    expect(inFlight.kind).toBe("in-flight");
    expect(inFlight.reason).toContain("already in flight");

    const tooSoon = answerPollNow(NOW + 1_000, where({ lastTakenAt: NOW }));
    expect(tooSoon.kind).toBe("too-soon");
    expect(tooSoon.reason).toContain("a moment ago");

    // A runner that will not poll again says so rather than promising a poll it
    // can never make. This is the refusal that matters most and is easiest to
    // forget, because it is a stretch of minutes rather than a moment: `--once`
    // waiting out its sessions, a session the server ended, and a stop all sit
    // here with the view still on screen.
    const finishing = answerPollNow(NOW, where({ finishing: true }));
    expect(finishing.kind).toBe("finishing");
    expect(finishing.reason).toContain("No more polls are coming");

    // The spacing is a floor rather than a rule about how often a person may
    // ask: past it, the same press is taken.
    expect(answerPollNow(NOW + POLL_NOW_MIN_GAP_MS, where({ lastTakenAt: NOW })).kind).toBe("taken");

    // And a refusal reaches the screen, which is the whole point of saying it.
    const refused = applyEvent(emptyView, { kind: "asked", taken: false, reason: inFlight.reason }, AT);
    expect(refused.note).toBe(inFlight.reason);
    expect(applyEvent(refused, { kind: "asked", taken: true, reason: null }, AT).note).toBeNull();
  });

  it("105-S63: every key the view names is one it accepts, and every key it accepts is named", () => {
    expect(actionForKey("p", press())).toEqual({ to: "loop", request: "poll-now" });
    expect(actionForKey("q", press())).toEqual({ to: "loop", request: "quit" });
    expect(actionForKey("", press({ downArrow: true }))).toEqual({ to: "screen", action: "older" });
    expect(actionForKey("", press({ upArrow: true }))).toEqual({ to: "screen", action: "newer" });
    expect(actionForKey("", press({ escape: true }))).toEqual({ to: "screen", action: "clear" });
    // A key the table does not hold does nothing rather than being guessed at.
    expect(actionForKey("x", press())).toBeNull();

    // The hints and the matcher are one table, so the screen cannot offer a key
    // that does nothing or accept one it never named.
    const hinted = keyHints().join(" ");
    for (const binding of KEY_BINDINGS) expect(hinted).toContain(binding.label);
    expect(keyHints()).toContain("q or ctrl-c — stop");
    expect(keyHints()).toContain("↑ or ↓ — pick a recent run");
    expect(render(liveView(emptyView, frame())).lastFrame()).toContain("p — poll now");
    // A terminal whose stdin cannot be put in raw mode reads none of them, and
    // offering a key nothing is listening for is worse than offering none.
    expect(render(liveView(emptyView, frame({ keysActive: false }))).lastFrame()).not.toContain("p — poll now");
  });

  it("105-S64: ctrl-c asks to stop, because reading keys is what stops it arriving as a signal", () => {
    expect(actionForKey("c", press({ ctrl: true }))).toEqual({ to: "loop", request: "quit" });
    // Bound to the same request the quit key is, so both reach the handler the
    // signal would have reached. A plain `c` is not it.
    expect(actionForKey("c", press())).toBeNull();
    const screen = readFileSync(fileURLToPath(new URL("../src/run/screen.ts", import.meta.url)), "utf8");
    expect(screen).toMatch(/exitOnCtrlC: false/);
  });

  it("105-S64: the keys that ask the runner for something reach it through the real screen", async () => {
    // The table is a claim about what Ink delivers, and a hand-built
    // `KeyModifiers` cannot check it: `` arriving as `c` with ctrl is Ink's
    // behaviour rather than this module's, so an Ink that spelled it differently
    // would leave the table and its test agreeing and the binding dead. That
    // binding is the only way to stop a runner from the terminal it runs in.
    const asked: ViewRequest[] = [];
    const { stdin } = render(liveScreenFor(emptyView, (request) => asked.push(request)));
    await settle();
    stdin.write("p");
    await settle();
    stdin.write("q");
    await settle();
    // Last, because the interrupt also ends the surface it was pressed on.
    stdin.write("");
    await settle();
    expect(asked).toEqual(["poll-now", "quit", "quit"]);
  });

  it("105-S65: the presenter with no keyboard invents no person, and its lines carry no countdown", async () => {
    const plain = await drive({ isTTY: false });
    let asked = false;
    plainPresenter(() => {}).listen(() => {
      asked = true;
    });
    expect(asked).toBe(false);
    expect(plain.out.join("\n")).not.toContain("next poll in");
    expect(plain.out.join("\n")).not.toContain("poll now");
  });

  it("105-S66: only the keys that ask the runner for something leave the screen", () => {
    const toLoop = KEY_BINDINGS.filter((b) => b.action.to === "loop").map((b) => b.label);
    expect(toLoop).toEqual(["p", "q", "ctrl-c"]);
    // The screen reaches nothing that could poll, claim or spawn: a request is
    // the only thing that crosses, and the loop is what answers it.
    const screen = readFileSync(fileURLToPath(new URL("../src/run/screen.ts", import.meta.url)), "utf8");
    const imports = screen.match(/^import .*$/gm) ?? [];
    expect(imports.some((line) => /auth\/api|work\/instruction|run\/execute|node:/.test(line))).toBe(false);
    const command = readFileSync(fileURLToPath(new URL("../src/commands/run.ts", import.meta.url)), "utf8");
    expect(command).toMatch(/presenter\.listen\(onRequest\)/);
  });

  it("105-S61: a poll a person asks for cuts the wait short, and the next one is a whole interval after it", async () => {
    // The real sleeper, so the wake a keypress reaches is the one `run` waits
    // on; a stubbed sleep would register no wake and the causal chain under
    // test would not exist.
    const { waitFor } = await import("../src/commands/run.ts");
    let at = new Date(2026, 8, 4, 12, 0, 0).getTime();
    const deadlines: (number | null)[] = [];
    let waits = 0;

    const result = await drive(
      {
        isTTY: true,
        now: () => new Date(at),
        count: async () => {
          at += 1_000;
          return { waiting: 0, capped: false };
        },
        sleep: (ms, signal) => {
          const waiting = waitFor(ms, signal);
          waits += 1;
          // Pressed in the middle of the wait, which is when a person presses it.
          at += 20_000;
          captured.handler?.(waits === 1 ? "poll-now" : "quit");
          return waiting;
        },
      },
      { once: false },
    );

    for (const event of captured.events) {
      if (event.kind === "phase") deadlines.push(event.phase.kind === "waiting" ? event.phase.at : null);
    }
    expect(result.code).toBe(0);
    // Two polls: the one at start, and the one the key asked for.
    expect(captured.events.filter((e) => e.kind === "poll")).toHaveLength(2);
    expect(captured.events.some((e) => e.kind === "asked" && e.taken)).toBe(true);
    // `null` is a poll in flight; a number is a deadline. The deadline offered
    // before the wait is a whole interval from the moment it was said, so a
    // poll a person asked for restarts the interval rather than inheriting the
    // remainder of the one nobody waited out.
    const said = deadlines.filter((d): d is number => d !== null);
    expect(said).toHaveLength(2);
    // The first poll is at 12:00:01 and the deadline it sets is five minutes on.
    expect(said[0]).toBe(new Date(2026, 8, 4, 12, 0, 1).getTime() + 300_000);
    // The key is pressed at 12:00:21, twenty seconds into that wait, and the
    // poll it causes lands at 12:00:22. **The next deadline is five minutes
    // after that** — 12:05:22 — rather than the 12:05:01 an unreset interval
    // would have kept, which is the whole of what resetting means.
    expect(said[1]).toBe(new Date(2026, 8, 4, 12, 0, 22).getTime() + 300_000);
    // Two ticks, each announcing itself, and one `finishing` at the end.
    expect(deadlines.filter((d) => d === null)).toHaveLength(3);
  });

  it("105-S64: the stop key ends the run the way the signal does, and says what stopping cost", async () => {
    const { waitFor } = await import("../src/commands/run.ts");
    const result = await drive(
      {
        isTTY: true,
        count: async () => ({ waiting: 0, capped: false }),
        sleep: (ms, signal) => {
          const waiting = waitFor(ms, signal);
          captured.handler?.("quit");
          return waiting;
        },
      },
      { once: false },
    );
    expect(result.code).toBe(0);
    expect(captured.events.some((e) => e.kind === "stopped")).toBe(true);

    // The stop is acknowledged on the keypress rather than at the end of it.
    // Every running session now gets its grace period, which can be minutes, and
    // a screen still counting down through that counts down to nothing.
    const kinds = captured.events.map((e) => (e.kind === "phase" ? `phase:${e.phase.kind}` : e.kind));
    expect(kinds).toContain("phase:finishing");
    expect(kinds.indexOf("phase:finishing")).toBeLessThan(kinds.indexOf("stopped"));

    // And a poll asked for after that is refused rather than promised.
    const { answerPollNow: answer } = await import("../src/run/loop.ts");
    expect(answer(NOW, { polling: false, finishing: true, lastTakenAt: null }).kind).toBe("finishing");
  });

  it("105-S71: `--once` says it will not poll again before it waits out its sessions", async () => {
    // The window this closes is not a moment: after its single tick, `--once`
    // sits waiting for every session it started, which can run for minutes with
    // the view still drawn and the keys still offered.
    const driven = await drive({ isTTY: true });
    expect(driven.code).toBe(0);
    const kinds = captured.events.map((e) => (e.kind === "phase" ? `phase:${e.phase.kind}` : e.kind));
    expect(kinds).toContain("phase:polling");
    expect(kinds).toContain("phase:finishing");
    expect(kinds.indexOf("phase:finishing")).toBeLessThan(kinds.indexOf("stopped"));
    // And never a deadline, because there is no next poll to count down to.
    expect(kinds).not.toContain("phase:waiting");
  });
});

describe("run: the message a run left behind", () => {
  const NOW = new Date(2026, 8, 4, 12, 4, 1).getTime();
  const frame = (over: Partial<ScreenFrame> = {}): ScreenFrame => ({ now: NOW, keysActive: true, selection: null, ...over });
  const feed = (events: RunEvent[]) => events.reduce((state, event) => applyEvent(state, event, AT), emptyView);
  const twoRuns = () =>
    feed([
      { kind: "configured", agent: "a" },
      { kind: "done", agent: "a", claim: "c1", ms: 1000, costUsd: 0.1, turns: 1, message: "Triaged three files." },
      { kind: "failed", agent: "a", claim: "c2", outcome: "failed", ms: 2000, message: "the harness reported no credential" },
    ]);

  it("105-S67: a finished run carries the harness's own words, on the event rather than off the log", async () => {
    const view = twoRuns();
    expect(view.recent.map((r) => r.message)).toEqual(["the harness reported no credential", "Triaged three files."]);
    expect(view.recent.map((r) => r.claim)).toEqual(["c2", "c1"]);

    // The field the screen shows and the field the run log writes are the same
    // one — `outcome.message` — so the two cannot come to differ.
    const driven = await drive({ isTTY: true });
    const logged = driven.rows[0] as { message: string; claim: string };
    const shown = captured.events.find((e) => e.kind === "done");
    expect(shown).toBeDefined();
    expect(shown && shown.kind === "done" && shown.message).toBe(logged.message);

    // And it is still never read back off the file.
    const source = readFileSync(fileURLToPath(new URL("../src/run/view.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\b(readFile|readFileSync|appendRun|runLogPath)\s*\(/);
  });

  it("105-S68: the cursor picks a run by its claim, so a run arriving under it moves nothing", () => {
    const view = twoRuns();
    // Down from nothing lands on the newest, which is what pressing down on a
    // list you are not yet in means.
    const first = moveSelection(view.recent, null, "older");
    expect(first).toBe("c2");
    expect(selectedRun(view.recent, first)!.message).toContain("no credential");

    // A run finishing pushes the list down; the selection is still the same run.
    const after = applyEvent(view, { kind: "done", agent: "a", claim: "c3", ms: 5, costUsd: null, turns: null, message: "Third." }, AT);
    expect(after.recent[0].claim).toBe("c3");
    expect(selectedRun(after.recent, first)!.claim).toBe("c2");

    expect(moveSelection(view.recent, "c2", "older")).toBe("c1");
    // The oldest is the end of the list rather than a wrap.
    expect(moveSelection(view.recent, "c1", "older")).toBe("c1");
    // Up off the top leaves the list, so closing needs no second key learnt.
    expect(moveSelection(view.recent, "c2", "newer")).toBeNull();
    expect(moveSelection(view.recent, "c1", "clear")).toBeNull();
    // A selected run that has fallen out of the window resolves to nothing
    // rather than to whatever now sits at its index.
    expect(selectedRun(view.recent, "gone")).toBeNull();
    expect(moveSelection([], null, "older")).toBeNull();
  });

  it("105-S68: the picked run stays picked when a new run arrives above it, on the real screen", async () => {
    // `moveSelection` and `selectedRun` are pure and cannot see the component
    // that holds the selection between events. The list grows from the top, so
    // this is the arrangement in which a cursor keyed on a position would come
    // to mean a different run without anybody pressing anything.
    const settle = async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
    };
    const before = twoRuns();
    const { lastFrame, stdin, rerender } = render(liveScreenFor(before));
    await settle();
    stdin.write("[B");
    await settle();
    expect(lastFrame() ?? "").toContain("claim c2");

    const after = applyEvent(before, { kind: "done", agent: "a", claim: "c3", ms: 5, costUsd: null, turns: null, message: "Third." }, AT);
    rerender(liveScreenFor(after));
    await settle();
    expect(after.recent[0].claim).toBe("c3");
    expect(lastFrame() ?? "").toContain("claim c2");
    expect(lastFrame() ?? "").toContain("the harness reported no credential");
  });

  it("105-S69: a long message is cut with the cut said out loud, and the log is named for the rest", () => {
    const long = "x".repeat(MESSAGE_PREVIEW_LIMIT + 40);
    const cut = messagePreview(long);
    expect(cut.truncated).toBe(true);
    expect(cut.text.endsWith("…")).toBe(true);
    expect(cut.text.length).toBe(MESSAGE_PREVIEW_LIMIT + 1);
    expect(messagePreview("  short  ")).toEqual({ text: "short", truncated: false });
  });

  it("105-S70: the picked run is drawn with its message, and nothing is drawn when none is picked", () => {
    const view = twoRuns();
    const closed = render(liveView(view, frame())).lastFrame() ?? "";
    expect(closed).toContain("Recent runs");
    expect(closed).not.toContain("The run you picked");
    expect(closed).not.toContain("claim c2");

    const open = render(liveView(view, frame({ selection: "c2" }))).lastFrame() ?? "";
    expect(open).toContain("The run you picked");
    expect(open).toContain("the harness reported no credential");
    expect(open).toContain("claim c2");
    // The cursor is a mark rather than a highlight, so the row reads the same
    // on a terminal that does not honour inverse video.
    expect(open).toContain("› a");
  });

  it("105-S70: the arrows open a run on the real screen, and escape closes it", async () => {
    const DOWN = "[B";
    const UP = "[A";
    const ESCAPE = "";
    // Several event-loop turns pass between a keystroke and the frame it
    // produces, which is React's scheduling rather than anything here.
    const settle = async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
    };
    const { lastFrame, stdin } = render(liveScreenFor(twoRuns()));
    await settle();
    expect(lastFrame() ?? "").not.toContain("The run you picked");
    stdin.write(DOWN);
    await settle();
    expect(lastFrame() ?? "").toContain("claim c2");
    stdin.write(DOWN);
    await settle();
    expect(lastFrame() ?? "").toContain("Triaged three files.");
    stdin.write(UP);
    await settle();
    expect(lastFrame() ?? "").toContain("claim c2");
    stdin.write(ESCAPE);
    await settle();
    expect(lastFrame() ?? "").not.toContain("The run you picked");
  });
});

describe("run: when a run happened", () => {
  const ENDED = new Date(2026, 8, 4, 12, 4, 1);
  const frame = (over: Partial<ScreenFrame> = {}): ScreenFrame => ({
    now: ENDED.getTime() + 3 * 60_000,
    keysActive: true,
    selection: null,
    ...over,
  });
  const oneRun = (at: Date) =>
    [
      { kind: "configured", agent: "a" } as RunEvent,
      { kind: "done", agent: "a", claim: "c1", ms: 1000, costUsd: 0.1, turns: 1, message: "Triaged three files." } as RunEvent,
    ].reduce((state, event) => applyEvent(state, event, at), emptyView);

  it("105-S94: a recent run remembers the stamp its own event carried", () => {
    const view = oneRun(ENDED);
    expect(view.recent[0].at).toEqual(ENDED);

    // The screen's stamp and the log's stamp are the same value, so a row and a
    // line cannot come to disagree about when a session ended.
    const logged = plainLine({ at: ENDED, event: { kind: "done", agent: "a", claim: "c1", ms: 1000, costUsd: 0.1, turns: 1, message: "x" } });
    expect(logged).toContain(clockText(view.recent[0].at));
  });

  it("105-S94: the row says the clock and the age together", () => {
    const drawn = render(liveView(oneRun(ENDED), frame())).lastFrame() ?? "";
    expect(drawn).toContain("12:04:01 · 3m ago");
  });

  it("105-S94: the stamps land in one column, whatever is in front of them", () => {
    // Four variable-width fields sit between a row and its stamp, so without
    // padding the stamps land in as many places as there are rows and the eye
    // has to find each one.
    const view = [
      { kind: "done", agent: "a", claim: "c1", ms: 1_000, costUsd: 0.1, turns: 1, message: "x" } as RunEvent,
      { kind: "failed", agent: "a-much-longer-name", claim: "c2", outcome: "failed", ms: 3_600_000, message: "y" } as RunEvent,
    ].reduce((state, event) => applyEvent(state, event, ENDED), emptyView);
    const rows = (render(liveView(view, frame())).lastFrame() ?? "")
      .split("\n")
      .filter((line) => line.includes("12:04:01 ·"));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((line) => line.indexOf("12:04:01")))).toHaveLength(1);
  });

  it("105-S95: the age is coarse, and answers ten-minutes-ago or yesterday", () => {
    expect(agoText(0)).toBe("just now");
    expect(agoText(59_000)).toBe("just now");
    // A clock that disagrees with itself by a moment is likelier than a run that
    // has not happened yet.
    expect(agoText(-5_000)).toBe("just now");
    expect(agoText(60_000)).toBe("1m ago");
    expect(agoText(10 * 60_000)).toBe("10m ago");
    expect(agoText(59 * 60_000)).toBe("59m ago");
    expect(agoText(64 * 60_000)).toBe("1h ago");
    expect(agoText(23 * 3_600_000)).toBe("23h ago");
    expect(agoText(25 * 3_600_000)).toBe("1d ago");
    expect(agoText(3 * 86_400_000)).toBe("3d ago");
  });

  it("105-S96: the date is announced first and then only when the local day changes", () => {
    const monday = new Date(2026, 8, 7, 23, 59, 30);
    const stillMonday = new Date(2026, 8, 7, 23, 59, 59);
    const tuesday = new Date(2026, 8, 8, 0, 0, 4);

    expect(dayLine(null, monday)).toBe("Mon 7 Sep 2026");
    expect(dayLine(monday, stillMonday)).toBeNull();
    // Fourteen seconds apart and two dates: the calendar day is the question,
    // not the elapsed time.
    expect(dayLine(stillMonday, tuesday)).toBe("Tue 8 Sep 2026");
    // And twenty hours apart on one day is still one date.
    expect(dayLine(tuesday, new Date(2026, 8, 8, 20, 0, 0))).toBeNull();
  });

  it("105-S97: the log prints the date and the screen draws nothing for it", () => {
    const lines: string[] = [];
    const plain = plainPresenter((line) => lines.push(line), () => ENDED);
    plain.present({ kind: "day", date: "Fri 4 Sep 2026" });
    expect(lines).toEqual(["12:04:01 day       Fri 4 Sep 2026"]);

    // The screen has no use for it: every run there says its own age.
    const before = oneRun(ENDED);
    expect(applyEvent(before, { kind: "day", date: "Sat 5 Sep 2026" }, ENDED)).toBe(before);
  });

  it("105-S97: a plain run says its date before its first line", async () => {
    const driven = await drive({ isTTY: false });
    expect(driven.code).toBe(0);
    expect(driven.out[0]).toBe("12:04:01 day       Fri 4 Sep 2026");
    // And once only, for a run that never crosses midnight.
    expect(driven.out.filter((line) => line.includes(" day  ")).length).toBe(1);
  });

  it("105-S96: a runner that crosses midnight announces the new date, before the first line of it", async () => {
    // Which day it is is decided by `dayLine` and remembered by the runner, and
    // only the runner can be asked the second half: a fixed clock cannot tell a
    // runner that announces once from one that announces per day, and a runner
    // left up overnight is the whole reason this event exists.
    let tick = 0;
    // Five seconds a call from ten seconds before midnight, so the run crosses
    // it wherever the calls happen to fall.
    const driven = await drive({ now: () => new Date(2026, 8, 7, 23, 59, 50 + 5 * tick++) });
    expect(driven.code).toBe(0);

    const days = driven.out.filter((line) => line.includes(" day  "));
    expect(days).toHaveLength(2);
    expect(days[0]).toContain("Mon 7 Sep 2026");
    expect(days[1]).toContain("Tue 8 Sep 2026");

    // The announcement is the first thing said on the new day, which is what
    // makes the lines under it unambiguous rather than merely dated somewhere.
    expect(driven.out.findIndex((line) => line.startsWith("00:"))).toBe(driven.out.indexOf(days[1]));
  });

  it("105-S98: the run you picked says the date in full", () => {
    const drawn = render(liveView(oneRun(ENDED), frame({ selection: "c1" }))).lastFrame() ?? "";
    expect(drawn).toContain("ended Fri 4 Sep 2026, 12:04:01 · 3m ago");
  });

  it("105-S99: no existing plain line changed shape", () => {
    const at = ENDED;
    expect(plainLine({ at, event: { kind: "done", agent: "a", claim: "3f2a9911aa", ms: 458_000, costUsd: 0.42, turns: 23, message: "x" } })).toBe(
      "12:04:01 done      a  claim 3f2a…  7m38s  $0.42  turns 23",
    );
    expect(plainLine({ at, event: { kind: "poll", agents: ["a"], waiting: 2 } })).toBe("12:04:01 poll      asked for a — 2 waiting");
    expect(plainLine({ at, event: { kind: "phase", phase: { kind: "polling" } } })).toBeNull();
  });
});

describe("run: the clock behind the ages", () => {
  const ENDED = new Date(2026, 8, 4, 12, 4, 1);

  it("105-S94: every outcome the runner has fits the column, not only the two a person sees most", () => {
    // Four of the six are longer than `failed`, so a width chosen from the
    // common pair would push the stamp sideways on exactly the rows somebody is
    // scanning for.
    //
    // Two frames rather than one, because `RECENT_LIMIT` is five and there are
    // six kinds: a single view silently drops the oldest, and a case that drew
    // five of six while saying *every* would be quiet about whichever it lost.
    // The agent name is the same in both, so the width they share is too.
    const stampColumns = (kinds: readonly OutcomeKind[]) => {
      const view = kinds.reduce(
        (state, kind, i) =>
          applyEvent(state, { kind: "failed", agent: "a", claim: `c${i}`, outcome: kind, ms: 1_000, message: "x" }, ENDED),
        emptyView,
      );
      const rows = (render(liveView(view, { now: ENDED.getTime(), keysActive: true, selection: null })).lastFrame() ?? "")
        .split("\n")
        .filter((line) => line.includes("12:04:01 ·"));
      // Every kind asked for was drawn: a frame short of a row would agree about
      // the column while saying nothing about the kind that went missing.
      expect(rows).toHaveLength(kinds.length);
      return rows.map((line) => line.indexOf("12:04:01"));
    };

    const columns = [...stampColumns(OUTCOME_KINDS.slice(0, 3)), ...stampColumns(OUTCOME_KINDS.slice(3))];
    expect(columns).toHaveLength(OUTCOME_KINDS.length);
    expect(new Set(columns)).toHaveLength(1);
  });

  it("105-S95: the age keeps moving in the phases that have no countdown", async () => {
    // `--once`, a stop's grace and a session the server ended are all stretches
    // of minutes with no deadline. Gated on the deadline alone the clock froze
    // at mount, and every row read `just now` for the rest of the process.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(ENDED);
      // A second short of eleven minutes old, so one tick of the clock is enough
      // to change what the row says.
      const finished = new Date(ENDED.getTime() - (11 * 60_000 - 1_000));
      const view = applyEvent(
        applyEvent(emptyView, { kind: "done", agent: "a", claim: "c1", ms: 1_000, costUsd: 0.1, turns: 1, message: "x" }, finished),
        { kind: "phase", phase: { kind: "finishing" } },
        ENDED,
      );
      const { lastFrame } = render(liveScreenFor(view));
      expect(lastFrame() ?? "").toContain("10m ago");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(lastFrame() ?? "").toContain("11m ago");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("run: the in-`run` version notice", () => {
  const NOW = new Date(2026, 8, 4, 12, 4, 1).getTime();
  const PERIOD_MS = 6 * 60 * 60 * 1000;
  const frame = (over: Partial<ScreenFrame> = {}): ScreenFrame => ({ now: NOW, keysActive: true, selection: null, ...over });
  const feed = (events: RunEvent[]) => events.reduce((state, event) => applyEvent(state, event, AT), emptyView);
  const HOW = "Run `mdbrain upgrade` to replace it.";
  const notice: RunEvent = { kind: "version", version: "0.2.0", how: HOW };
  // The check is started and never awaited, so its answer lands a few microtasks
  // after the command has returned. That is the design and not a race: a poll
  // loop must not have its timing put behind somebody else's host.
  const settleChecks = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("114-S8: a note sent after a version notice does not erase it", () => {
    const after = feed([
      { kind: "configured", agent: "a" },
      notice,
      { kind: "note", message: "The run log could not be written: EACCES" },
    ]);

    expect(after.versionNotice).toContain("0.2.0");
    expect(after.note).toBe("The run log could not be written: EACCES");
    expect(render(liveView(after, frame())).lastFrame()).toContain("0.2.0");

    // Every sender that owns the `note` slot, one after another, plus the two
    // events that clear it. None of them reaches the notice, which is the whole
    // reason it is not a `note`.
    const survivors: RunEvent[] = [
      { kind: "note", message: "a renamed agent" },
      { kind: "note", message: "the count could not be read" },
      { kind: "note", message: "the claim failed" },
      { kind: "note", message: "an unreadable instruction" },
      { kind: "note", message: "work for an agent this runner is not running" },
      { kind: "poll", agents: ["a"], waiting: 0 },
      { kind: "asked", taken: true, reason: null },
    ];
    const battered = survivors.reduce((state, event) => applyEvent(state, event, AT), after);
    expect(battered.versionNotice).toBe(after.versionNotice);
    expect(render(liveView(battered, frame())).lastFrame()).toContain("0.2.0");

    // The notice is drawn ABOVE the note, which is a decision rather than an
    // accident of the order two pushes were written in: a note is the last thing
    // that happened and this stays true until the runner is restarted, so the
    // transient line belongs nearer the countdown that also moves. Asserted as two
    // indices, because swapping the pushes leaves every presence assertion above
    // satisfied. The two lookups are checked to have found their lines first, so a
    // frame that stopped drawing either one fails here rather than comparing -1.
    const lines = render(liveView(after, frame())).lastFrame()!.split("\n");
    const noticeAt = lines.findIndex((l) => l.includes("0.2.0 is available"));
    const noteAt = lines.findIndex((l) => l.includes("EACCES"));
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(noteAt).toBeGreaterThanOrEqual(0);
    expect(noticeAt).toBeLessThan(noteAt);

    // The control, and it is what makes the assertion above mean anything: the
    // same fact sent as a `note` is gone after the first of those fires.
    const asNote = feed([
      { kind: "note", message: "mdbrain 0.2.0 is available." },
      { kind: "note", message: "the claim failed" },
    ]);
    expect(asNote.note).not.toContain("0.2.0");
  });

  it("114-S9: both presenters render it, in the same words", async () => {
    const { versionNoticeText } = await import("../src/upgrade/notice.ts");
    const sentence = versionNoticeText({ version: "0.2.0", how: HOW });

    const line = plainLine({ at: AT, event: notice });
    expect(line).not.toBeNull();
    expect(line).toContain(sentence);
    expect(line).toContain("version");

    const drawn = render(liveView(feed([{ kind: "configured", agent: "a" }, notice]), frame())).lastFrame();
    expect(drawn).toContain(sentence);

    // A kind rendered by one presenter and not the other is the failure this
    // asserts, and it is the two assertions on `sentence` above that catch it —
    // one per presenter. These two are weaker restatements: `sentence` already
    // contains both strings, so neither can fail while the assertion above it
    // passes. They are kept because they name, in the case itself, what each
    // presenter is expected to carry.
    expect(line).toContain("0.2.0");
    expect(drawn).toContain("mdbrain upgrade");
  });

  it("114-S9: a packaged install is told its own packager's command, not this one", async () => {
    const { versionNoticeFor } = await import("../src/upgrade/notice.ts");
    const brew = versionNoticeFor("0.1.0", "0.2.0", "homebrew", true);
    expect(brew?.how).toContain("brew");
    expect(brew?.how).not.toContain("mdbrain upgrade");
    expect(versionNoticeFor("0.1.0", "0.2.0", "direct", true)?.how).toContain("mdbrain upgrade");
  });

  it("114-S13: once at startup, then every six hours, and no oftener", async () => {
    const { VERSION_CHECK_PERIOD_MS, versionCheckDue } = await import("../src/upgrade/notice.ts");
    const { AuthError } = await import("../src/auth/api.ts");
    expect(VERSION_CHECK_PERIOD_MS).toBe(PERIOD_MS);

    // Nothing checked yet is due, which is what makes the check at startup
    // happen without a second code path asking for one.
    expect(versionCheckDue(null, NOW)).toBe(true);
    expect(versionCheckDue(NOW, NOW)).toBe(false);
    expect(versionCheckDue(NOW, NOW + PERIOD_MS - 1)).toBe(false);
    expect(versionCheckDue(NOW, NOW + PERIOD_MS)).toBe(true);

    // A day of ticking, driven through the command with a clock that moves a
    // minute at a time. The session ending is what stops the loop, since a
    // runner otherwise polls for as long as it is left up.
    const TICKS = 24 * 60;
    let clock = NOW;
    let ticks = 0;
    let asked = 0;
    await drive(
      {
        now: () => new Date(clock),
        lookupLatest: async () => {
          asked += 1;
          return null;
        },
        count: async () => {
          if (ticks >= TICKS) throw new AuthError(401, "JWT expired");
          ticks += 1;
          clock += 60_000;
          return { waiting: 0, capped: false };
        },
        sleep: async () => {},
      },
      { once: false },
    );
    await settleChecks();

    expect(ticks).toBe(TICKS);
    // Once at startup, and once at each of the four six-hour boundaries a day
    // holds. A check on every tick would be 1440.
    expect(asked).toBe(5);
  }, 20_000);

  it("114-S14: a lookup that fails writes nothing — not the screen, not the log, not the exit code", async () => {
    const { versionNoticeFor } = await import("../src/upgrade/notice.ts");
    // The pure half: a failed lookup and an already-current version are both
    // nothing to say, and neither carries a reason anybody could print.
    expect(versionNoticeFor("0.1.0", null, "direct", true)).toBeNull();
    expect(versionNoticeFor("0.1.0", "0.1.0", "direct", true)).toBeNull();

    const failed = await drive({ lookupLatest: async () => null });
    await settleChecks();
    const said = [...failed.out, ...failed.err].join("\n");
    expect(said).not.toMatch(/is available/);
    expect(said).not.toMatch(/could not be checked|check failed|latest version/i);
    expect(failed.code).toBe(0);
    // The run log is the half a screen assertion cannot see, and it is where the
    // declined line would be reintroduced as a tidy-up.
    expect(JSON.stringify(failed.rows)).not.toMatch(/is available|version check/i);

    // The neuter that makes the three assertions above an instrument rather than
    // a formality: the same channel does carry the notice when there is one, so
    // they are watching something that works.
    const announced = await drive({ lookupLatest: async () => "0.2.0" });
    await settleChecks();
    expect(announced.out.join("\n")).toMatch(/is available/);
  });

  it("114-S14: a second check finding the same tag does not say it twice", async () => {
    const { AuthError } = await import("../src/auth/api.ts");
    let clock = NOW;
    let ticks = 0;
    let asked = 0;
    const run = await drive(
      {
        now: () => new Date(clock),
        lookupLatest: async () => {
          asked += 1;
          return "0.2.0";
        },
        count: async () => {
          if (ticks >= 3) throw new AuthError(401, "JWT expired");
          ticks += 1;
          // A full period between ticks, so every one of them is due.
          clock += PERIOD_MS;
          return { waiting: 0, capped: false };
        },
        sleep: async () => {},
      },
      { once: false },
    );
    await settleChecks();

    // Asked every time it was due — the period is not what is under test here —
    // and said once, because the second answer told nobody anything new. A
    // runner up for a week would otherwise repeat the line twenty-eight times.
    expect(asked).toBeGreaterThan(1);
    expect(run.out.filter((line) => line.includes("is available"))).toHaveLength(1);
  });

  it("114-S20: a lookup still outstanding when the run ends is abandoned, and says nothing after it", async () => {
    const { VERSION_CHECK_TIMEOUT_MS } = await import("../src/upgrade/notice.ts");
    // Bounded well inside `fetch`'s own five minutes, which is the number this
    // exists to not be.
    expect(VERSION_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(30_000);

    let signal: AbortSignal | undefined;
    let answer: ((version: string | null) => void) | undefined;
    const run = await drive({
      lookupLatest: (given) => {
        signal = given;
        return new Promise<string | null>((resolve) => {
          answer = resolve;
        });
      },
    });

    // It returned at all, with the lookup still outstanding: nothing waits on
    // this, at the end any more than during a tick.
    expect(run.code).toBe(0);
    // And it was abandoned rather than left holding the process open. This
    // program sets an exit code and lets the loop drain, so a request nobody is
    // waiting on is still a reason the prompt does not come back.
    expect(signal?.aborted).toBe(true);

    // An answer that arrives anyway lands nowhere. The plain presenter has no
    // guard of its own — it prints whatever it is handed — so without this the
    // notice would appear beneath the line that says the runner stopped.
    const settled = run.out.length;
    answer?.("0.2.0");
    await settleChecks();
    expect(run.out).toHaveLength(settled);
    expect(run.out.join("\n")).not.toMatch(/is available/);
  });

  it("114-S20: a Ctrl-C abandons the lookup too, and the drain after it says nothing", async () => {
    // The last line is not the only route. Between a stop and that line the run
    // waits on every session's grace, which can be minutes, and `presenting` is
    // still true for all of it — so a lookup that answers in that window is
    // drawn under a screen the person has already asked to be rid of. The stop
    // handler's abort is what closes it: with the call removed this case sees a
    // `version` event and the assertion below fails.
    let answer: ((v: string | null) => void) | undefined;
    let release: (() => void) | undefined;
    const grace = new Promise<void>((r) => {
      release = r;
    });

    const run = await drive(
      {
        isTTY: true,
        count: async () => ({ waiting: 1, capped: false }),
        startSession: async () => {
          await grace;
          return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stopped: false, signal: null, spawnProblem: null };
        },
        lookupLatest: (given) =>
          new Promise<string | null>((resolve, reject) => {
            answer = resolve;
            // A real aborted fetch rejects; without this the abort is invisible
            // here and the case would pass whether or not it happened.
            given.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        sleep: async () => {
          captured.handler?.("quit");
          answer?.("0.2.0");
          await settleChecks();
          release?.();
        },
      },
      { once: false },
    );

    expect(run.code).toBe(0);
    // The notice reaches the live view as an event rather than as a line, so
    // asserting on `out` here would pass however loudly it was drawn.
    expect(captured.events.filter((e) => e.kind === "version")).toHaveLength(0);
  });

  it("114-S20: the lookup is given a signal, and an aborted one is silent like any other failure", async () => {
    const { latestVersion } = await import("../src/upgrade/latest.ts");
    const controller = new AbortController();
    controller.abort();
    // The lookup answers null for an abort exactly as it does for an unreachable
    // host: both callers want the same thing from a failure and neither wants a
    // reason.
    const aborted = await latestVersion(
      (_url, init) => {
        expect((init as RequestInit).signal).toBeDefined();
        throw new DOMException("aborted", "AbortError");
      },
      "owner/repo",
      controller.signal,
    );
    expect(aborted).toBeNull();

    // The signal reaches the request rather than being accepted and dropped.
    let passed: AbortSignal | null | undefined;
    await latestVersion(
      async (_url, init) => {
        passed = (init as RequestInit).signal;
        return new Response(null, { status: 302, headers: { location: "https://x/releases/tag/v0.2.0" } });
      },
      "owner/repo",
      controller.signal,
    );
    expect(passed).toBe(controller.signal);
  });
});

describe("run: the diagnosis log", () => {
  it("redacts every credential shape it can name, and says which it cannot", async () => {
    const { redactSecrets } = await import("../src/run/diagnosis.ts");

    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF-_123";
    expect(redactSecrets(`token ${jwt} refused`)).toBe("token [redacted] refused");
    expect(redactSecrets("key smd_agent_deadbeef_secretpart")).toBe("key [redacted]");
    expect(redactSecrets("sb_publishable_AbCdEf123456 and sb_secret_ZyXwVu987654")).toBe("[redacted] and [redacted]");
    expect(redactSecrets("Authorization: Bearer abc123def456ghi")).toBe("Authorization: Bearer [redacted]");

    // An opaque refresh token is the shape no pattern separates from a word, so
    // it is the length cap and not this function that bounds it.
    expect(redactSecrets("Sign in to ask for work.")).toBe("Sign in to ask for work.");
  });

  it("a refused poll names which of the two calls it was, the status, and the server's words", async () => {
    const { refusedMessage, SAID_LIMIT } = await import("../src/run/diagnosis.ts");
    const said = "Your session is no longer accepted.";

    const counting = refusedMessage(said, "count", 401, "Sign in to ask for work.");
    const claiming = refusedMessage(said, "claim", 401, "Sign in to ask for work.");
    expect(counting).toContain(said);
    expect(counting).toContain("HTTP 401");
    expect(counting).toContain("Sign in to ask for work.");
    // The whole point: two refusals that used to be the same sentence.
    expect(counting).not.toBe(claiming);
    expect(counting).toMatch(/waiting/);
    expect(claiming).toMatch(/claiming/);

    // A rate limit and a gateway failure must not read the same.
    expect(refusedMessage(said, "count", 429, "over_request_rate_limit")).toContain("HTTP 429");

    const long = refusedMessage(said, "count", 500, "x".repeat(SAID_LIMIT + 200));
    expect(long.length).toBeLessThan(said.length + SAID_LIMIT + 100);
    expect(refusedMessage(said, "count", 401, "bearer abc123def456ghi")).toContain("[redacted]");
    // A body that was empty leaves no dangling "the server said:".
    expect(refusedMessage(said, "count", 401, "   ")).not.toContain("the server said");

    // A proxy's HTML error page arrives verbatim, newlines and all, into a
    // sentence printed as one line and a file written one record per line.
    const page = refusedMessage(said, "count", 502, "<html>\n  <body>\n    Bad gateway\n  </body>\n</html>");
    expect(page).not.toContain("\n");
    expect(page).toContain("Bad gateway");
  });

  it("the rows are one line of JSON each, in a file that is not the run log", async () => {
    const { diagnosisPath, diagnosisText, refusedRow, startRow, stopRow } = await import("../src/run/diagnosis.ts");
    const { runLogPath } = await import("../src/run/log.ts");
    const env = { env: { MDBRAIN_STATE_DIR: "/state" }, platform: "linux" as const, home: "/home/d" };

    expect(diagnosisPath(env)).not.toBe(runLogPath(env));
    expect(diagnosisPath(env)).toContain("diagnosis.jsonl");

    const at = new Date(Date.UTC(2026, 8, 9, 16, 0, 7));
    const start = startRow(at, {
      version: "0.1.0",
      channel: "direct",
      compiled: true,
      runtime: { engine: "bun", engineVersion: "1.2.0", execPath: "/opt/mdbrain", platform: "linux-x64" },
      keyStore: "keychain",
      keyStoreWhere: "the keychain",
      configPath: "/home/d/.config/mdbrain/config.json",
      asking: ["dev-bot-mdden"],
      held: [{ agent: "other", reason: "no key" }],
      pollMs: 30_000,
    });
    expect(start.at).toBe("2026-09-09T16:00:07.000Z");
    expect(diagnosisText(start).endsWith("\n")).toBe(true);
    expect(diagnosisText(start).trimEnd()).not.toContain("\n");
    expect(JSON.parse(diagnosisText(start))).toMatchObject({ kind: "start", keyStore: "keychain" });

    expect(refusedRow(at, "claim", 401, `key smd_agent_deadbeef_x`).said).toBe("key [redacted]");
    // The row itself is what has to be flat, and asserting it on the LINE cannot
    // fail: `JSON.stringify` escapes a newline whatever the field holds, so a row
    // carrying a raw newline still serialises to one line and the file's contract
    // survives a value that would be unreadable when it is read back.
    const page = refusedRow(at, "count", 502, "<html>\n bad\n</html>");
    expect(page.said).toBe("<html> bad </html>");
    expect(diagnosisText(page).trimEnd()).not.toContain("\n");
    expect(stopRow(at, "session-ended", 1, 3)).toMatchObject({ kind: "stop", reason: "session-ended", exitCode: 1, sessions: 3 });
  });

  it("a start is written down with the key store and the runtime that chose it", async () => {
    const started = await drive();
    const start = started.notes.find((n) => n.kind === "start");
    expect(start).toBeDefined();
    // The sentence that scrolls away, and the fact that decides it — neither of
    // which survived anywhere before.
    expect(start).toMatchObject({ keyStore: "keychain", keyStoreWhere: "the keychain" });
    expect(["bun", "node"]).toContain((start as { runtime: { engine: string } }).runtime.engine);
    expect((start as { asking: string[] }).asking).toEqual(["dev-bot-mdden"]);
  });

  // The build is injected so the notice can be compared against something other
  // than this binary. The row has to read that same seam: a run whose notice is
  // about one build and whose log records another explains the wrong machine.
  it("the start row records the build the run was given, not the one it was compiled as", async () => {
    const started = await drive({ build: { version: "9.9.9", channel: "homebrew", isCompiled: true } });
    const start = started.notes.find((n) => n.kind === "start") as unknown as {
      version: string;
      channel: string;
      compiled: boolean;
    };
    expect({ version: start.version, channel: start.channel, compiled: start.compiled }).toEqual({
      version: "9.9.9",
      channel: "homebrew",
      compiled: true,
    });
  });

  it("a run with nobody to ask still leaves a start and a stop", async () => {
    const held = await drive({ env: {}, roster: async () => [] });
    expect(held.notes.map((n) => n.kind)).toEqual(["start", "stop"]);
    expect(held.notes[1]).toMatchObject({ reason: "all-held", exitCode: 1 });
  });

  it("a refusal is written down, and the count and the claim are told apart", async () => {
    const { AuthError } = await import("../src/auth/api.ts");

    const counting = await drive({
      count: async () => {
        throw new AuthError(401, "Sign in to ask for work.");
      },
    });
    expect(counting.err.join("\n")).toContain("HTTP 401");
    expect(counting.notes.find((n) => n.kind === "refused")).toMatchObject({ call: "count", status: 401 });

    const claiming = await drive({
      claim: async () => {
        throw new AuthError(401, "Sign in to ask for work.");
      },
    });
    expect(claiming.notes.find((n) => n.kind === "refused")).toMatchObject({ call: "claim", status: 401 });
    // The two screens a person cannot currently tell apart.
    expect(counting.err.join("\n")).not.toBe(claiming.err.join("\n"));
    expect(claiming.notes.at(-1)).toMatchObject({ kind: "stop", reason: "session-ended", exitCode: 1 });
  });

  it("a throw that escapes the loop still ends the start it left open", async () => {
    // A start with nothing after it reads exactly like a process that was killed,
    // which is the one ambiguity the file exists to remove.
    const boom = new Error("the presenter threw while drawing");
    const notes: import("../src/run/diagnosis.ts").DiagnosisRow[] = [];
    await expect(
      drive(
        {
          recordDiagnosis: async (row) => {
            notes.push(row);
          },
          // The wait between polls is inside the loop's `try` and caught nowhere.
          sleep: async () => {
            throw boom;
          },
        },
        { once: false },
      ),
    ).rejects.toThrow(boom);
    expect(notes.map((n) => n.kind)).toEqual(["start", "stop"]);
    expect(notes.at(-1)).toMatchObject({ kind: "stop", reason: "threw", exitCode: 1 });
  });

  it("a diagnosis that cannot be written is a note, never the reason a run failed", async () => {
    const broken = await drive({
      recordDiagnosis: async () => {
        throw new Error("disk full");
      },
    });
    expect(broken.code).toBe(0);
    expect(broken.out.join("\n")).toContain("disk full");
  });

  it("the roster is the third call authorised the same way, and its words are redacted too", async () => {
    const { AuthError } = await import("../src/auth/api.ts");
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF-_123";
    const refused = await drive({
      roster: async () => {
        throw new AuthError(401, `upstream refused: Authorization: Bearer ${token}`);
      },
    });
    expect(refused.code).toBe(1);
    expect(refused.err.join("\n")).not.toContain(token);
    expect(refused.err.join("\n")).toContain("[redacted]");
  });
});
