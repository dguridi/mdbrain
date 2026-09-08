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
import { UNREADABLE_OUTCOME_MESSAGE, readOutcome, resultObject, type SessionEnd } from "../src/run/outcome.ts";
import { logRow, rowText } from "../src/run/log.ts";
import { costText, durationText, plainLine, plainPresenter, shortClaim, type RunEvent } from "../src/run/present.ts";
import type { Config } from "../src/config/schema.ts";
import { mcpConfigText } from "../src/config/store.ts";
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

    const declared = Object.keys((JSON.parse(mcpConfigText("MDBRAIN_KEY_DEV_BOT_MDDEN")) as { mcpServers: Record<string, unknown> }).mcpServers);
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
    sleep: async () => {},
    now: () => new Date(2026, 8, 4, 12, 4, 1),
    ...over,
  };
  const code = await runRun(deps, { positional: [], flags: { once: true, ...flags }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, rows, spawned };
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
  const feed = (events: RunEvent[]) => events.reduce((state, event) => applyEvent(state, event), emptyView);

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
    });
    expect(running.agents[0]).toMatchObject({ state: "running", note: "file-arrived #8412 · 01-ideas" });

    const back = applyEvent(running, { kind: "done", agent: "dev-bot-mdden", claim: "c1", ms: 1000, costUsd: 1, turns: 2, message: "Done." });
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
    const after = applyEvent(queued, { kind: "done", agent: "a", claim: "c1", ms: 1, costUsd: null, turns: null, message: "Done." });
    expect(after.agents[0].queued).toBe(1);
  });

  it("a tick-level skip changes nothing: the agent is already running, which is that fact said usefully", () => {
    const before = feed([
      { kind: "configured", agent: "a" },
      { kind: "start", agent: "a", claim: "c", unitKind: "k", seq: 1, workspace: "w" },
    ]);
    expect(applyEvent(before, { kind: "skipped", agent: "a", reason: "a: a session is already running." })).toBe(before);
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
  const feed = (events: RunEvent[]) => events.reduce((state, event) => applyEvent(state, event), emptyView);
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

    expect(countdownText(applyEvent(waiting, { kind: "phase", phase: { kind: "polling" } }), NOW)).toBe("polling now");
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
    const refused = applyEvent(emptyView, { kind: "asked", taken: false, reason: inFlight.reason });
    expect(refused.note).toBe(inFlight.reason);
    expect(applyEvent(refused, { kind: "asked", taken: true, reason: null }).note).toBeNull();
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
  const feed = (events: RunEvent[]) => events.reduce((state, event) => applyEvent(state, event), emptyView);
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
    const after = applyEvent(view, { kind: "done", agent: "a", claim: "c3", ms: 5, costUsd: null, turns: null, message: "Third." });
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

    const after = applyEvent(before, { kind: "done", agent: "a", claim: "c3", ms: 5, costUsd: null, turns: null, message: "Third." });
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
