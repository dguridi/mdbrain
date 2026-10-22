import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_SERVER_NAME, MCP_URL } from "../src/auth/project.ts";
import { mcpConfigPath, writeMcpConfig } from "../src/config/store.ts";
import {
  POLL_NOW_MIN_GAP_MS,
  answerPollNow,
  CLAIM_LIMIT,
  placeWork,
  planStartup,
  renamedAgents,
  rosterView,
  summaryLines,
  tickPlan,
  type PollNowState,
} from "../src/run/loop.ts";
import { childEnvironment, claudeHarness, harnessFor, type Invocation } from "../src/run/harness.ts";
import {
  MAY_HAVE_CHANGED_FILES,
  OUTCOME_KINDS,
  UNREADABLE_OUTCOME_MESSAGE,
  readOutcome,
  resultObject,
  type OutcomeKind,
  type SessionEnd,
} from "../src/run/outcome.ts";
import { holdConnectionKeys } from "../src/run/connection-keys.ts";
import { logRow, parseRunLog, readRunLog, rowText } from "../src/run/log.ts";
import { SIGNAL_DEBOUNCE_MS, SIGNAL_MIN_GAP_MS } from "../src/run/signal.ts";
import { agoText, clockText, costText, dayLine, durationText, plainLine, plainPresenter, RUN_TITLE, shortClaim, type RunEvent } from "../src/run/present.ts";
import { VERSION } from "../src/version.ts";
import { POLL_MS, type Config } from "../src/config/schema.ts";

import type { WorkUnit } from "../src/work/instruction.ts";
import {
  MESSAGE_PREVIEW_LIMIT,
  RECENT_LIMIT,
  applyEvent,
  cursorClaims,
  emptyView,
  messagePreview,
  moveSelection,
  pickedSession,
  restoredRecent,
  selectedRun,
  waitedText,
} from "../src/run/view.ts";
import { render } from "ink-testing-library";
import {
  ACTIVE_COLOR,
  connectionRow,
  countdownText,
  ENDING_BY_YOU,
  FAILED_COLOR,
  KILL_OUTRUN,
  killQuestion,
  LIVE_COLOR,
  liveScreenFor,
  liveView,
  SETTLED_COLOR,
  STATE_COLOR,
  type ScreenFrame,
} from "../src/run/screen.ts";
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
  handler: null as ((request: import("../src/run/keys.ts").ViewRequest) => void) | null,
  events: [] as import("../src/run/present.ts").RunEvent[],
  /** Each time the view gave the terminal up or took it back, in order. */
  terminal: [] as string[],
  /** Called when the view takes the terminal back, so a test can act just after. */
  onResume: null as (() => void) | null,
  /** The recent runs the view was handed to open with. */
  initial: [] as import("../src/run/view.ts").RecentRun[],
}));

vi.mock("../src/run/screen.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/run/screen.ts")>();
  return {
    ...actual,
    livePresenter: (_out: unknown, _now: unknown, recent: readonly import("../src/run/view.ts").RecentRun[] = []) => {
      captured.initial = [...recent];
      return {
        present(event: import("../src/run/present.ts").RunEvent) {
          captured.events.push(event);
        },
        listen(handler: (request: import("../src/run/keys.ts").ViewRequest) => void) {
          captured.handler = handler;
        },
        suspend() {
          captured.terminal.push("suspend");
          return Promise.resolve();
        },
        resume() {
          captured.terminal.push("resume");
          captured.onResume?.();
        },
        stop: () => Promise.resolve(),
      };
    },
  };
});

beforeEach(() => {
  captured.handler = null;
  captured.events = [];
  captured.terminal = [];
  captured.onResume = null;
  captured.initial = [];
});

const entry = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  harness: "claude" as const,
  pollsWork: true,
  cwd,
  env: { harness: "ANTHROPIC_API_KEY" as string | null, connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" },
  limits: {},
  ...over,
});

const config = (agents: Record<string, unknown> = { "dev-bot-mdden": entry() }, over: Record<string, unknown> = {}): Config =>
  ({ version: 1, sessionsPerHour: 10, agents, ...over }) as Config;

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
  session: { kind: "new", id: "3f2a0000-0000-4000-8000-000000000000" },
  agent: "dev-bot-mdden",
  mcpConfigPath: "/cfg/mcp/dev-bot-mdden.json",
  cwd,
  limits: {},
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
  stoppedBy: null,
  windows: false,
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
    const held = planStartup(config({ "dev-bot": entry() }), { ANTHROPIC_API_KEY: "x" }, () => true, rosterView([{ id: "agent-9", display_name: "someone-else" }]));
    expect(held.asking).toEqual([]);
    expect(held.held[0].reason).toContain("not in the roster");

    const renamed = renamedAgents(config({ "dev-bot": entry({ id: "agent-1" }) }), new Map([["dev-bot-mdden", "agent-1"]]));
    expect(renamed).toEqual([{ configuredAs: "dev-bot", nowCalled: "dev-bot-mdden", id: "agent-1" }]);
  });

  it("158-S6: a name the roster holds under a different id is held as recreated rather than asked for", () => {
    const plan = planStartup(
      config({ "dev-bot": entry({ id: "agent-old" }) }),
      { ANTHROPIC_API_KEY: "x" },
      () => true,
      rosterView([{ id: "agent-new", display_name: "dev-bot" }]),
    );
    expect(plan.asking).toEqual([]);
    expect(plan.held).toEqual([
      { agent: "dev-bot", reason: "its agent was deleted in markdownbrain.ai, and an agent of the same name now has a new id: run mdbrain configure." },
    ]);

    // A rename is still held the way it always was: the id is there, the name is not.
    const renamed = planStartup(
      config({ "dev-bot": entry({ id: "agent-1" }) }),
      { ANTHROPIC_API_KEY: "x" },
      () => true,
      rosterView([{ id: "agent-1", display_name: "dev-bot-mdden" }]),
    );
    expect(renamed.held[0].reason).toContain("not in the roster");

    const live = planStartup(
      config({ "dev-bot": entry({ id: "agent-1" }) }),
      { ANTHROPIC_API_KEY: "x" },
      () => true,
      rosterView([{ id: "agent-1", display_name: "dev-bot" }]),
    );
    expect(live.asking).toEqual(["dev-bot"]);
  });

  it("105-S22: the summary names the agents held and why, and the run log", () => {
    const plan = planStartup(
      config({ alice: entry(), bob: entry({ env: { harness: "B_KEY", connectionKey: "K_B" } }) }),
      { ANTHROPIC_API_KEY: "x" },
      () => true,
      null,
    );
    const lines = summaryLines(plan, "/state/runs.jsonl", "  Connection keys are held in a file.");
    const text = lines.join("\n");
    expect(text).toContain("Held: bob — B_KEY is not set.");
    expect(text).toContain("Run log: /state/runs.jsonl");
    expect(text).toContain("Connection keys are held in a file.");
  });

  it("121-S17: a healthy runner with a working keychain says its name and build and where the log is, and nothing else", () => {
    const plan = planStartup(
      config({ alice: entry(), bob: entry() }),
      { ANTHROPIC_API_KEY: "x" },
      () => true,
      null,
    );
    expect(plan.held).toEqual([]);
    // Two lines rather than six, and the live view draws one of them: the block
    // sat above a roster that already names every agent, and a countdown that
    // already says when the next poll is.
    expect(summaryLines(plan, "/state/runs.jsonl", null)).toEqual([RUN_TITLE, "  Run log: /state/runs.jsonl"]);
  });

  it("121-S18: a held agent keeps its line and its reason, which is the fact nothing else on screen carries", () => {
    const plan = planStartup(
      config({ alice: entry(), bob: entry({ env: { harness: "B_KEY", connectionKey: "K_B" } }) }),
      { ANTHROPIC_API_KEY: "x" },
      () => true,
      null,
    );
    const lines = summaryLines(plan, "/r", null);
    expect(lines).toContain("  Held: bob — B_KEY is not set.");
    // And the agents that are fine are not named: the roster below says so.
    expect(lines.join("\n")).not.toContain("alice");
  });

  it("121-S19: a runner that will ask for nobody still says so, since it has no held lines to explain it", () => {
    const plan = planStartup(config({ alice: entry() }), {}, () => true, null);
    expect(plan.asking).toEqual([]);
    const lines = summaryLines(plan, "/r", null);
    expect(lines).toContain("  Asking for nobody: every configured agent is held.");
  });

  it("125-S27: an identity-only agent is not asked for and is not held, whatever this machine would have held it for", () => {
    const plan = planStartup(
      config({ alice: entry(), bob: entry({ pollsWork: false }) }),
      { ANTHROPIC_API_KEY: "x" },
      () => true,
      null,
    );
    expect(plan.asking).toEqual(["alice"]);
    expect(plan.attended).toEqual(["bob"]);
    expect(plan.held).toEqual([]);

    // Every hold this process knows about at once — an unset variable, a
    // directory that is gone, a name no roster holds — and none of them applies
    // to an agent this process will never ask for.
    const wouldHold = planStartup(
      config({ bob: entry({ pollsWork: false, env: { harness: "B_KEY", connectionKey: "K_B" }, cwd: "/gone" }) }),
      {},
      () => false,
      rosterView([{ id: "agent-9", display_name: "somebody-else" }]),
    );
    expect(wouldHold.held).toEqual([]);
    expect(wouldHold.attended).toEqual(["bob"]);

    // And one line for the lot of them, since there is no reason to read.
    const lines = summaryLines(plan, "/r", null);
    expect(lines).toContain("  Identity only, not asked for work: bob.");
    expect(lines.join("\n")).not.toContain("Asking for nobody");
  });

  it("125-S28: a machine where nothing is asked for says that, rather than saying everything is held", () => {
    const plan = planStartup(config({ bob: entry({ pollsWork: false }) }), { ANTHROPIC_API_KEY: "x" }, () => true, null);
    expect(plan.asking).toEqual([]);
    const lines = summaryLines(plan, "/r", null);
    expect(lines).toContain("  Asking for nobody: every agent configured here is identity-only.");
    expect(lines.join("\n")).not.toContain("every configured agent is held");

    // A held agent beside them is a machine with something to fix, and the held
    // sentence is the one that says so.
    const mixed = planStartup(
      config({ alice: entry({ env: { harness: "A_KEY", connectionKey: "K_A" } }), bob: entry({ pollsWork: false }) }),
      {},
      () => true,
      null,
    );
    expect(mixed.asking).toEqual([]);
    expect(summaryLines(mixed, "/r", null)).toContain("  Asking for nobody: every configured agent is held.");
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
  it("names an unattended session after its agent, once, and not as an attended one", () => {
    const built = claudeHarness.build(invocation({ agent: "Field Notes" }));
    const names = built.args.filter((_, i) => built.args[i - 1] === "--name");
    expect(names).toEqual(["Field Notes"]);
  });

  it("sets no cross-session inbound policy in either mode, so the harness's own default holds", () => {
    for (const built of [claudeHarness.build(invocation()), claudeHarness.buildInteractive(invocation())]) {
      expect(built.args.join(" ")).not.toContain("crossSessionInbound");
      expect(built.args).not.toContain("--settings");
      expect(built.args).not.toContain("--setting-sources");
      expect(Object.keys(built.env).filter((name) => /CROSS_SESSION/i.test(name))).toEqual([]);
    }
  });

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
    expect(built.args[at + 1]).toBe("mcp__markdownbrain");

    const declared = Object.keys((JSON.parse(claudeHarness.mcpConfigText("MDBRAIN_KEY_DEV_BOT_MDDEN")) as { mcpServers: Record<string, unknown> }).mcpServers);
    expect(declared).toEqual(["markdownbrain"]);
    expect(built.args[at + 1]).toBe(`mcp__${declared[0]}`);
  });

  it("105-S88: the allowance is that one server and nothing else", () => {
    const built = claudeHarness.build(invocation());
    const allowed = built.args.filter((_, i) => built.args[i - 1] === "--allowedTools");
    expect(allowed).toEqual(["mcp__markdownbrain"]);
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
    for (const limits of [{}, { maxBudgetUsd: 0.01, wallClock: "1m" }, { maxBudgetUsd: 100, wallClock: "2h" }]) {
      const built = claudeHarness.build(invocation({ limits }));
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
    const out = denied([{ tool_name: "mcp__markdownbrain__whoami" }]);
    expect(out.kind).toBe("failed");
    expect(out.message).toContain("mcp__markdownbrain__whoami");
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
    for (const shape of [[{}], ["mcp__markdownbrain__whoami"], [7], [{ tool: null }]]) {
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
    const out = denied([{ tool_name: "Bash" }, { tool_name: "mcp__markdownbrain__whoami" }]);
    expect(out.kind).toBe("failed");
    expect(out.message).toContain("mcp__markdownbrain__whoami");
  });

  it("105-S93: refused both kinds, the harness's own are still counted beside the verdict", () => {
    const out = denied([{ tool_name: "Bash" }, { tool_name: "Bash" }, { tool_name: "mcp__markdownbrain__whoami" }]);
    expect(out.kind).toBe("failed");
    expect(out.message).toContain("mcp__markdownbrain__whoami");
    expect(out.message).toContain("2 Bash calls");
    expect(out.message).toContain("declined along the way");
    // And the counts stay in that note. The verdict names the supplied tool
    // without one, because there the number changes nothing: one refusal of the
    // workspace server ends the session as surely as twenty. Asserted against
    // the literal, since threading a count through the verdict leaves every
    // other case here green.
    expect(out.message).toContain("It needed mcp__markdownbrain__whoami, and it was refused");
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
      { kind: "start", agent: "dev-bot-mdden", claim: "3f2a1111-aaaa", unitKind: "file-arrived", seq: 8412, workspace: "01-ideas", file: "01-ideas/37-a-doctor-command.md", brain: "markdown brain", recordedAt: AT.toISOString() },
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

  it("163-S2: a real spawn reports its pid once the harness has started, and a missing command reports nothing", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { spawn } = await import("node:child_process");
    const spawned: (number | undefined)[] = [];
    const ran = await runSession(
      {
        spawnable: { command: process.execPath, args: ["-e", "0"], env: { PATH: process.env.PATH ?? "" } },
        cwd: process.cwd(),
        wallClockMs: 5_000,
        onSpawned: (pid) => spawned.push(pid),
      },
      { spawn, isWindows: process.platform === "win32" },
    );
    expect(ran.spawnProblem).toBeNull();
    expect(spawned).toHaveLength(1);
    expect(typeof spawned[0]).toBe("number");

    // `spawn()` returns a child for a command that is not there and says so
    // only afterwards, which is why the record waits for the event.
    const missing: (number | undefined)[] = [];
    const failed = await runSession(
      {
        spawnable: { command: "definitely-not-a-real-command-mdbrain", args: [], env: {} },
        cwd: process.cwd(),
        wallClockMs: 5_000,
        onSpawned: (pid) => missing.push(pid),
      },
      { spawn, isWindows: process.platform === "win32" },
    );
    expect(failed.spawnProblem).not.toBeNull();
    expect(missing).toEqual([]);
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

  it("105-S102: a session is spawned on a console of its own, so nothing it starts can write under the live view", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { spawn } = await import("node:child_process");
    const options: Record<string, unknown>[] = [];
    const ended = await runSession(
      {
        spawnable: { command: process.execPath, args: ["-e", "process.stdout.write('piped')"], env: { PATH: process.env.PATH ?? "" } },
        cwd: process.cwd(),
        wallClockMs: 10_000,
      },
      {
        spawn: ((command: string, args: string[], opts: Record<string, unknown>) => {
          options.push(opts);
          return spawn(command, args, opts);
        }) as typeof spawn,
        isWindows: process.platform === "win32",
      },
    );
    expect(options).toHaveLength(1);
    expect(options[0].windowsHide).toBe(true);
    expect(options[0].stdio).toEqual(["ignore", "pipe", "pipe"]);
    // The hidden console must not cost the pipes, which are where the result is read.
    expect(ended.stdout).toBe("piped");
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
  // The presence connection, stood in: what it was asked to publish, the tokens
  // it was handed, and whether it was closed.
  const wanted: Array<Map<string, string>> = [];
  const refreshed: string[] = [];
  let closes = 0;
  let opened: import("../src/run/realtime.ts").PresenceLinkOptions | null = null;
  // The listening connection, stood in the same way: what it was told to listen
  // to, the tokens it was handed, whether it was closed, and — the one that
  // matters — a handle on the callback a delivered signal arrives through.
  const signalRefreshed: string[] = [];
  /** Each call of the brain-name read, with the ids it was given. */
  const nameAsks: string[][] = [];
  let signalCloses = 0;
  let signalsOpened: import("../src/run/signals.ts").SignalLinkOptions | null = null;
  let fire: ((dueInMs: number) => void) | null = null;
  // The in-flight records, in memory: what is on "disk" now, and every write
  // and removal in the order they happened.
  const inFlight = new Map<string, import("../src/run/inflight.ts").InFlightRecord>();
  const inFlightLog: string[] = [];
  const resumesAsked: import("../src/commands/resume.ts").ResumeTarget[] = [];
  const deps: import("../src/commands/run.ts").RunDeps = {
    isTTY: false,
    isWindows: false,
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
    roster: async () => [{ id: "agent-1", org_id: "o", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-agent-1" }],
    count: async () => ({ waiting: 1, capped: false }),
    claim: async () => ({ work: [unit()], refused: [] }),
    askToStart: async () => ({ status: 200, said: "", minimum: null, sent: "0.1.0" }),
    writeMcpFile: async (agent) => mcpConfigPath(agent),
    startSession: async (request) => {
      spawned.push(request.spawnable);
      return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null };
    },
    recordRun: async (row) => {
      rows.push(row);
      inFlightLog.push(`row ${(row as { claim: string }).claim}`);
    },
    recoverUsage: async () => null,
    recordDiagnosis: async (row) => {
      notes.push(row);
    },
    inFlight: {
      write: async (record) => {
        inFlight.set(record.claim, record);
        inFlightLog.push(`write ${record.claim}`);
      },
      remove: async (claim) => {
        inFlight.delete(claim);
        inFlightLog.push(`remove ${claim}`);
      },
      list: async () => [...inFlight.values()],
      lock: async () => null,
      nameHarness: async () => {},
      unlock: async () => {},
    },
    readRunLog: async () => "",
    isAlive: () => false,
    pid: 4410,
    prepareResume: async (target) => {
      resumesAsked.push(target);
      return null;
    },
    sleep: async () => {},
    now: () => new Date(2026, 8, 4, 12, 4, 1),
    lookupLatest: async () => null,
    openPresence: (options) => {
      opened = options;
      return {
        want: (desired) => wanted.push(new Map(desired)),
        refresh: (token) => refreshed.push(token),
        close: () => {
          closes += 1;
        },
      };
    },
    presenceNonce: () => "nonce",
    listenTo: async () => ["brain-1"],
    nameBrains: async (_token, ids) => {
      nameAsks.push([...ids]);
      return new Map(ids.map((id) => [id, "markdown brain"]));
    },
    openSignals: (options) => {
      signalsOpened = options;
      fire = options.onSignal;
      return {
        refresh: (token) => signalRefreshed.push(token),
        close: () => {
          signalCloses += 1;
        },
      };
    },
    build: { version: "0.1.0", channel: "direct", isCompiled: true },
    ...over,
  };
  const code = await runRun(deps, { positional: [], flags: { once: true, ...flags }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return {
    code,
    out,
    err,
    rows,
    notes,
    spawned,
    presence: { wanted, refreshed, closes: () => closes, opened: () => opened as import("../src/run/realtime.ts").PresenceLinkOptions | null },
    signals: {
      refreshed: signalRefreshed,
      closes: () => signalCloses,
      opened: () => signalsOpened as import("../src/run/signals.ts").SignalLinkOptions | null,
      fire: (dueInMs = 0) => fire?.(dueInMs),
    },
    nameAsks,
    inFlight,
    inFlightLog,
    resumesAsked,
  };
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

  it("125-S29: a machine of identity-only agents refuses with its own sentence, and records its own reason", async () => {
    const { ALL_HELD_MESSAGE, NOBODY_POLLS_MESSAGE } = await import("../src/commands/run.ts");
    const count = vi.fn(async () => ({ waiting: 1, capped: false }));
    const none = await drive({
      loadConfiguration: async () => ({ kind: "config", config: config({ "dev-bot-mdden": entry({ pollsWork: false }) }) }),
      count,
    });
    expect(none.code).toBe(1);
    expect(none.err.join("\n")).toBe(NOBODY_POLLS_MESSAGE);
    expect(none.err.join("\n")).not.toBe(ALL_HELD_MESSAGE);
    // Nothing was asked of the server: the refusal is before the first tick.
    expect(count).not.toHaveBeenCalled();

    const stop = none.notes.find((row) => row.kind === "stop");
    expect(stop && stop.kind === "stop" && stop.reason).toBe("none-polling");

    const start = none.notes.find((row) => row.kind === "start");
    expect(start && start.kind === "start" && start.attended).toEqual(["dev-bot-mdden"]);
    expect(start && start.kind === "start" && start.asking).toEqual([]);

    // One genuinely held agent beside them is a machine with something to fix,
    // and the refusal has to be the held sentence there — the startup block
    // saying so is not the same surface as the sentence the command exits on.
    const mixed = await drive({
      env: {},
      loadConfiguration: async () => ({
        kind: "config",
        config: config({ "dev-bot-mdden": entry(), "spec-warden": entry({ id: "agent-2", pollsWork: false }) }),
      }),
    });
    expect(mixed.code).toBe(1);
    expect(mixed.err.join("\n")).toBe(ALL_HELD_MESSAGE);
    const mixedStop = mixed.notes.find((row) => row.kind === "stop");
    expect(mixedStop && mixedStop.kind === "stop" && mixedStop.reason).toBe("all-held");
  });

  it("125-S29: an identity-only agent gets no presence identity and no work-signal topic", async () => {
    let listenedTo: string[] = [];
    const driven = await drive({
      loadConfiguration: async () => ({
        kind: "config",
        config: config({ "dev-bot-mdden": entry(), "spec-warden": entry({ id: "agent-2", pollsWork: false }) }),
      }),
      roster: async () => [
        { id: "agent-1", org_id: "o", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-agent-1" },
        { id: "agent-2", org_id: "o", display_name: "spec-warden", status: "active", bot_user_id: "u-agent-2" },
      ],
      listenTo: async (_token: string, agents: readonly string[]) => {
        listenedTo = [...agents];
        return ["brain-1"];
      },
    });
    expect(driven.code).toBe(0);
    expect(listenedTo).toEqual(["dev-bot-mdden"]);
    // The identity exists on this machine; what it is not is a member of this
    // run's roster, so nobody sees it come online for a session it never has.
    expect([...(driven.presence.opened()?.identities.keys() ?? [])]).toEqual(["dev-bot-mdden"]);
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
      stoppedBy: null,
      windows: false,
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
        stoppedBy: null,
        windows: false,
        signal: null,
        spawnProblem: "spawn claude ENOENT",
      }),
    });
    expect(spawnFailed.out.join("\n")).toContain("spawn claude ENOENT");
    expect(spawnFailed.rows[0]).toMatchObject({ outcome: "spawn-failed" });
    expect(asked).toBe(1);
  });

  it("105-S100: a session that throws instead of reporting still frees its agent and lets the queue drain", async () => {
    // Two units for one agent, and the first one's spawner throws rather than
    // coming back with a spawn problem — an edge nothing in the session path
    // anticipates, which is exactly why it is worth holding. Everything that
    // ends a unit runs after that await: the running flag, the queue behind it,
    // and the announcement that frees the agent. Removing the guard was measured
    // rather than argued: one session starts, the second never does, and the run
    // ends with a stop row reading `threw` that names no unit. A run that had
    // already stopped waiting on that session records nothing at all.
    let sessions = 0;
    const thrown = await drive({
      claim: async () => ({
        work: [unit("dev-bot-mdden", "c1", 1), unit("dev-bot-mdden", "c2", 2)],
        refused: [],
      }),
      startSession: async (request) => {
        sessions += 1;
        if (sessions === 1) throw new Error("the spawner came apart");
        return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null };
      },
    });
    // The second unit ran, which is the whole property: the queue behind a unit
    // that came apart is not stranded with it.
    expect(sessions).toBe(2);
    expect(thrown.rows).toHaveLength(2);
    expect(thrown.rows[0]).toMatchObject({ outcome: "spawn-failed" });
    // Reported rather than swallowed, and the underlying message is carried —
    // an outcome that named only itself would leave nobody able to say what
    // came apart.
    expect(thrown.out.join("\n")).toContain("the spawner came apart");
    expect(thrown.code).toBe(1);
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

  it("195-S14: the prompt reaches the harness with the mention manifest substituted into it", async () => {
    // Driven through the session start rather than `renderPrompt`, because the
    // manifest has to be handed over at the call site too: without it every
    // `{mentions}` renders the sentence for a row that recorded none.
    const mentioned: WorkUnit = {
      ...unit("dev-bot-mdden", "c1f0", 8412, {
        prompt: "Answer {mentions}",
        file: null,
        mentions: { thread: "t-a", comments: ["c-1", "c-2"], count: 2 },
      }),
      kind: "agent-mentioned",
    };
    const started = await drive({ claim: async () => ({ work: [mentioned], refused: [] }) });
    const args = started.spawned[0].args;
    expect(args[args.indexOf("-p") + 1]).toBe("Answer 2 mentions on thread `t-a`: comments `c-1` and `c-2`.");
  });

  it("185-S29: the prompt reaches the harness with the moment the firing was due substituted into it", async () => {
    // Driven through the session start for the reason the mention case is: a
    // call site that stopped handing `due` over would render nothing in its place.
    const fired: WorkUnit = {
      ...unit("dev-bot-mdden", "c1f0", 8412, {
        prompt: "This round was due at {due}.",
        file: null,
        due: "2026-10-20T09:00:00+02:00",
      }),
      kind: "schedule",
    };
    const started = await drive({ claim: async () => ({ work: [fired], refused: [] }) });
    const args = started.spawned[0].args;
    expect(args[args.indexOf("-p") + 1]).toBe("This round was due at 2026-10-20T09:00:00+02:00.");
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
        stoppedBy: null,
        windows: false,
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

  it("117-S1: a connection that cannot even be built does not stop the run", async () => {
    // The regression that would matter most, and the one a happy-path test
    // cannot see: presence is a consumer of the socket, and work is not.
    const dead = await drive({
      openPresence: () => {
        throw new Error("no socket here");
      },
    });
    expect(dead.code).toBe(0);
    expect(dead.rows).toHaveLength(1);
    expect(dead.out.join("\n")).toContain("work still arrives by poll");
  });

  it("117-S1: a socket that will not connect costs the roster dot and nothing else", async () => {
    const degraded = await drive({
      openPresence: (options) => {
        options.onState("unavailable");
        return { want: () => {}, refresh: () => {}, close: () => {} };
      },
    });
    expect(degraded.code).toBe(0);
    // Polled, claimed and ran exactly as it does with a socket.
    expect(degraded.rows).toHaveLength(1);
    expect(degraded.spawned).toHaveLength(1);
    // And said it once, in the vocabulary both presenters share.
    const said = degraded.out.filter((line) => line.includes("presence  "));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("work still arrives by poll");
  });

  it("117-S4: the poll happens on the runner's own schedule, whatever the socket did", async () => {
    // In this landing the poll IS the cursor read, and nothing signals. What
    // matters is that it is not conditional on the connection: a runner whose
    // socket never opened still asks, claims and runs.
    const count = vi.fn(async () => ({ waiting: 1, capped: false }));
    const silent = await drive({
      count,
      openPresence: () => ({ want: () => {}, refresh: () => {}, close: () => {} }),
    });
    expect(count).toHaveBeenCalledTimes(1);
    expect(silent.rows).toHaveLength(1);
  });

  it("the socket's token is refreshed on a tick that asks nobody, which is when it matters", async () => {
    // A tick asks nobody exactly when every configured agent is already running
    // — which is the only time the socket is joined and its roster entry is the
    // thing depending on a live token. Refreshing only on a tick that asked
    // would mean a single-agent runner never refreshed while it mattered.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const long = await drive(
      {
        session: async () => {
          reads += 1;
          if (reads < 6) return { kind: "ready", accessToken: `token-${reads}` };
          release();
          return { kind: "stop", reason: "sign-in", message: "Sign in with \`mdbrain login\`." };
        },
        startSession: async () => {
          await held;
          return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null };
        },
      },
      { once: false },
    );
    // token-1 is the startup read, before any tick. The first tick asked and
    // started the session; token-3 and token-4 are the two upkeep steps inside
    // the wait, which the interval is now long enough to be divided into; and
    // token-5 is the second tick, which asked nobody because the only agent was
    // still running — and refreshed all the same, which is the whole point.
    expect(long.presence.refreshed).toEqual(["token-2", "token-3", "token-4", "token-5"]);
    expect(long.out.join("\n")).toContain("skipped");
  }, 10_000);

  it("121-S5: the fixed interval is waited out in token-upkeep steps, and no tick asks for work in between", async () => {
    // The refresh rides the tick, which is only safe while a poll is far shorter
    // than a token's hour. Three quarters of an hour is not, so the token a socket
    // holds can expire before the tick that would replace it — and a work topic
    // lost that way is never rejoined by anything the socket itself can see,
    // because the connection stays up and keeps heartbeating.
    const slept: number[] = [];
    let ticks = 0;
    const slow = await drive(
      {
        // Nothing to do, so every tick is a count and no claim: what is being
        // measured is the upkeep between polls, not the work.
        count: async () => {
          ticks += 1;
          return { waiting: 0, capped: false };
        },
        session: async () => {
          if (ticks >= 2) return { kind: "stop", reason: "sign-in", message: "Sign in with `mdbrain login`." };
          return { kind: "ready", accessToken: `token-${slept.length}` };
        },
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
      { once: false },
    );

    // The wait is cut into steps no longer than a token may be held, rather than
    // taken as one long sleep nothing happens during.
    expect(Math.max(...slept)).toBeLessThanOrEqual(15 * 60_000);
    // One interval is three steps of a quarter of an hour, and they add back up to
    // the interval itself: the wait is divided, never shortened.
    expect(slept.slice(0, 3)).toEqual([900_000, 900_000, 900_000]);
    expect(slept.slice(0, 3).reduce((a, b) => a + b, 0)).toBe(POLL_MS);
    // Both sockets are handed every token the upkeep read, and the two links are
    // never allowed to drift apart on which one they hold.
    expect(slow.signals.refreshed.length).toBeGreaterThan(1);
    expect(slow.signals.refreshed).toEqual(slow.presence.refreshed);
    // And an upkeep is not a poll: it costs no count and claims nothing, so the
    // call volume the interval was configured to bound is unchanged.
    expect(ticks).toBeLessThan(slow.signals.refreshed.length);
  }, 10_000);

  // Dividing the wait put an `await` in the middle of it, and a wake is only
  // held by whatever sleep is running when it arrives. `waitFor` spends its
  // `wake` and nulls it the moment a step finishes, so a signal coming due while
  // the upkeep's session read is in flight calls nothing — and only a second ask
  // on the far side of the upkeep can still see that it happened.
  it("117-S24: a signal that comes due while the upkeep is in flight still ends the wait", async () => {
    vi.useFakeTimers();
    try {
      await signalDuringUpkeep();
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  async function signalDuringUpkeep() {
    const { AuthError } = await import("../src/auth/api.ts");
    let fire: ((dueInMs: number) => void) | null = null;
    let counts = 0;
    let sessions = 0;
    let release: (() => void) | null = null;
    let hold = false;
    const waits: number[] = [];

    const running = drive(
      {
        openSignals: (options) => {
          fire = options.onSignal;
          return { refresh: () => {}, close: () => {} };
        },
        // The real sleeper's contract, and the whole of what this case turns on:
        // a wake resolves the step once and is then spent and nulled.
        sleep: (ms, stop) => {
          if (stop.stopped) return Promise.resolve();
          return new Promise<void>((resolve) => {
            waits.push(ms);
            const timer = setTimeout(finish, ms);
            stop.wake = finish;
            function finish() {
              clearTimeout(timer);
              stop.wake = null;
              resolve();
            }
          });
        },
        session: async () => {
          sessions += 1;
          if (hold) {
            hold = false;
            await new Promise<void>((r) => (release = r));
          }
          return { kind: "ready", accessToken: `token-${sessions}` };
        },
        count: async () => {
          counts += 1;
          if (counts >= 2) throw new AuthError(401, "that is enough");
          return { waiting: 0, capped: false };
        },
      },
      { once: false },
    );

    for (let i = 0; i < 50 && waits.length === 0; i++) await vi.advanceTimersByTimeAsync(1);
    expect(counts).toBe(1);
    expect(waits[0]).toBe(900_000);

    // The next session read is the upkeep's, and it is held open so the signal
    // lands in exactly the window the divided wait introduced.
    hold = true;
    await vi.advanceTimersByTimeAsync(900_000);
    for (let i = 0; i < 50 && release === null; i++) await vi.advanceTimersByTimeAsync(1);
    expect(release).not.toBeNull();

    fire!(0);
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS + 1_000);
    release!();
    await vi.advanceTimersByTimeAsync(1);

    // The read the signal asked for, rather than one taken a further quarter of
    // an hour later when the next step happened to end.
    expect(counts).toBe(2);
    await running;
  }

  it("117-S21: a startup that learned no brains asks again on the tick, rather than staying deaf for the life of the run", async () => {
    // Every failure on the lookup path — a refusal, a server slower than the
    // bound, a network not up yet — answers with no brains. Taking that answer
    // once meant a runner spent days without a socket on the strength of five
    // seconds during boot, which is when a machine can least afford to answer.
    let asked = 0;
    let sessions = 0;
    const late = await drive(
      {
        listenTo: async () => {
          asked += 1;
          return asked === 1 ? [] : ["brain-1"];
        },
        count: async () => ({ waiting: 0, capped: false }),
        session: async () => {
          sessions += 1;
          if (sessions > 3) return { kind: "stop", reason: "sign-in", message: "Sign in with `mdbrain login`." };
          return { kind: "ready", accessToken: `token-${sessions}` };
        },
      },
      { once: false },
    );
    expect(asked).toBeGreaterThan(1);
    // The link is opened by the tick that finally got an answer, on that tick's
    // own token, and is not opened twice once it is up.
    expect(late.signals.opened()?.brains).toEqual(["brain-1"]);
    expect(late.signals.closes()).toBe(1);
  }, 10_000);

  it("117-S22: a link that is already open is not re-opened, and the lookup stops being made", async () => {
    let asked = 0;
    const up = await drive({
      listenTo: async () => {
        asked += 1;
        return ["brain-1"];
      },
    });
    // One answer at startup is enough: the tick asks only while there is no link.
    expect(asked).toBe(1);
    expect(up.signals.opened()?.brains).toEqual(["brain-1"]);
  });

  it("117-S3: the socket never outlives the run", async () => {
    const stopped = await drive();
    expect(stopped.presence.closes()).toBe(1);
  });

  it("117-S5, 117-S6: a stretch of queued units is one unbroken presence session", async () => {
    const two = await drive({
      claim: async () => ({ work: [unit("dev-bot-mdden", "c1"), unit("dev-bot-mdden", "c2")], refused: [] }),
    });
    expect(two.rows).toHaveLength(2);
    // Asserted on what the runner asked for rather than on what a socket did:
    // between the two units the flag goes false and true again, and every
    // reading in between still names the same agent in the same brain — except
    // the momentary empty one the linger is there to absorb.
    const naming = two.presence.wanted.filter((desired) => desired.size > 0);
    expect(naming.length).toBeGreaterThanOrEqual(2);
    for (const desired of naming) expect(desired.get("dev-bot-mdden")).toBe("01-ideas");
    // And the last word is that nobody is running, so the linger can run out.
    expect(two.presence.wanted.at(-1)?.size).toBe(0);
  });

  it("117-S5: presence is published for the brain the unit named, not a configured one", async () => {
    const elsewhere = await drive({
      claim: async () => ({ work: [unit("dev-bot-mdden", "c1", 1, { workspace: "another-brain" })], refused: [] }),
    });
    expect(elsewhere.presence.wanted.some((desired) => desired.get("dev-bot-mdden") === "another-brain")).toBe(true);
  });

  it("the connection is opened with this runner's own session and the agents it will ask for", async () => {
    const opened = (await drive()).presence.opened();
    expect(opened?.accessToken).toBe("token");
    expect([...(opened?.identities.keys() ?? [])]).toEqual(["dev-bot-mdden"]);
    expect(opened?.identities.get("dev-bot-mdden")).toEqual({ userId: "u-agent-1", name: "dev-bot-mdden" });
    expect(opened?.url).toContain("/realtime/v1/websocket");
  });

  it("publishes for nobody when the roster could not be read, rather than for a guess", async () => {
    const blind = await drive({
      roster: async () => {
        throw new Error("the roster timed out");
      },
    });
    expect(blind.presence.opened()?.identities.size).toBe(0);
  });

  it("117-S42: a roster that could not be read at startup is read again on the tick, and presence opens for it", async () => {
    let reads = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const late = await drive({
      roster: async (_token, signal) => {
        reads += 1;
        signals.push(signal);
        if (reads === 1) throw new Error("the roster timed out");
        return [{ id: "agent-1", org_id: "o", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-agent-1" }];
      },
    });
    expect(reads).toBe(2);
    // The read the tick asks for is bounded, so one that hangs cannot hold the
    // one-at-a-time guard for the life of the process.
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(late.presence.opened()?.identities.get("dev-bot-mdden")).toEqual({ userId: "u-agent-1", name: "dev-bot-mdden" });
    // The empty link it replaced is closed rather than left beside it.
    expect(late.presence.closes()).toBeGreaterThanOrEqual(2);
  });

  it("117-S42: a roster that was read is not read again, even when it names none of the agents", async () => {
    let reads = 0;
    await drive({
      roster: async () => {
        reads += 1;
        return [];
      },
    });
    expect(reads).toBe(1);
  });

  it("117-S42: once the roster has been read again, later ticks neither read it nor re-dial presence", async () => {
    let reads = 0;
    let ticks = 0;
    let dials = 0;
    await drive(
      {
        count: async () => {
          ticks += 1;
          return { waiting: 0, capped: false };
        },
        session: async () =>
          ticks >= 3
            ? { kind: "stop", reason: "sign-in", message: "Sign in with `mdbrain login`." }
            : { kind: "ready", accessToken: "token" },
        roster: async () => {
          reads += 1;
          if (reads === 1) throw new Error("the roster timed out");
          return [{ id: "agent-1", org_id: "o", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-agent-1" }];
        },
        openPresence: () => {
          dials += 1;
          return { want: () => {}, refresh: () => {}, close: () => {} };
        },
      },
      { once: false },
    );
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(reads).toBe(2);
    expect(dials).toBe(2);
  }, 10_000);

  it("117-S40: every session read asks for a token with more than one upkeep step left", async () => {
    const { TOKEN_AHEAD_SECONDS, TOKEN_UPKEEP_MS } = await import("../src/commands/run.ts");
    expect(TOKEN_AHEAD_SECONDS * 1_000).toBeGreaterThan(TOKEN_UPKEEP_MS);
    const asked: (number | undefined)[] = [];
    await drive({
      session: async (ahead) => {
        asked.push(ahead);
        return { kind: "ready", accessToken: "token" };
      },
    });
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(new Set(asked)).toEqual(new Set([TOKEN_AHEAD_SECONDS]));
  });

  it("117-S40: the upkeep step between polls asks ahead too, since it is the read that hands the sockets their token", async () => {
    // A single tick never reaches an upkeep step, and the upkeep is the read the
    // margin exists for: the poll is three steps long.
    const { TOKEN_AHEAD_SECONDS } = await import("../src/commands/run.ts");
    const asked: (number | undefined)[] = [];
    let ticks = 0;
    await drive(
      {
        count: async () => {
          ticks += 1;
          return { waiting: 0, capped: false };
        },
        session: async (ahead) => {
          asked.push(ahead);
          if (ticks >= 2) return { kind: "stop", reason: "sign-in", message: "Sign in with `mdbrain login`." };
          return { kind: "ready", accessToken: "token" };
        },
        sleep: async () => {},
      },
      { once: false },
    );
    // Startup, the first tick, and the upkeep steps of one interval at least.
    expect(asked.length).toBeGreaterThan(ticks + 1);
    expect(new Set(asked)).toEqual(new Set([TOKEN_AHEAD_SECONDS]));
  }, 10_000);

  it("117-S40: over a day of upkeep steps, no socket is ever handed a token that has expired", async () => {
    // The real decision, stepped the way the wait is cut. With the ordinary
    // sixty-second margin alone every refresh lands just after the expiry, which
    // is the hourly close of the room this exists to prevent.
    const { TOKEN_AHEAD_SECONDS, TOKEN_UPKEEP_MS } = await import("../src/commands/run.ts");
    const { refreshAhead, sessionAction } = await import("../src/auth/session.ts");
    const step = TOKEN_UPKEEP_MS / 1_000;
    for (const drift of [0.05, 0.5, 2, 30]) {
      let now = 1_000_000;
      let session = { accessToken: "t", refreshToken: "rt", expiresAt: now + 3600 };
      let refreshes = 0;
      for (let at = 0; at < (24 * 3600) / step; at += 1) {
        now += step + drift;
        const late = sessionAction(session, now).kind === "refresh";
        expect(late, `drift ${drift}s, step ${at}`).toBe(false);
        if (refreshAhead(session, now, TOKEN_AHEAD_SECONDS)) {
          session = { ...session, expiresAt: now + 3600 };
          refreshes += 1;
        }
      }
      expect(refreshes).toBeGreaterThanOrEqual(24);
    }
  });

  it("hands the socket the same fresh token each poll, since it outlives one by days", async () => {
    const refreshed = (await drive()).presence.refreshed;
    expect(refreshed).toEqual(["token"]);
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

  it("a key store that refuses the read is an outcome carrying the refusal, and not a crash", async () => {
    const refused = await drive({
      openKeyStore: async () => ({
        backend: { kind: "keychain", where: "the operating system's keychain" },
        get: async () => {
          throw new Error("this machine's keychain will not let this copy of mdbrain read a key an earlier copy stored");
        },
        set: async () => {},
        forget: async () => {},
      }),
    });
    expect(refused.out.join("\n")).toContain("will not let this copy of mdbrain read");
    expect(refused.rows[0]).toMatchObject({ outcome: "spawn-failed" });
  });

  it("what is spawned is what the harness built, with the connection key in the child", async () => {
    const spawned = await drive();
    expect(spawned.spawned[0].command).toBe("claude");
    expect(spawned.spawned[0].args).toContain("--strict-mcp-config");
    expect(spawned.spawned[0].env.MDBRAIN_KEY_DEV_BOT_MDDEN).toBe("smd_agent_deadbeef_secret");
  });

  it("the session a tick spawns is named after the agent its work was claimed for", async () => {
    // The builder cases hand `build` the agent themselves, so only a driven tick
    // can see which name the call site passes it.
    const started = await drive();
    const args = started.spawned[0].args;
    expect(args.filter((_, i) => args[i - 1] === "--name")).toEqual(["dev-bot-mdden"]);
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

  it("105-S101: the title names the product and this build, and the summary's first line is that same string", () => {
    expect(RUN_TITLE).toBe(`markdownbrain.ai agent runner v${VERSION}`);

    const drawn = render(liveView(feed([{ kind: "configured", agent: "dev-bot-mdden" }]), frame())).lastFrame() ?? "";
    expect(drawn).toContain(RUN_TITLE);
    // At the TOP, which is the whole of what the banner is for: it is drawn in
    // place of the line the summary keeps back, and a frame is read downwards.
    // Containment alone is satisfied by a banner drawn last, below the
    // countdown and the key hints.
    expect(drawn.split("\n")[0]).toContain(RUN_TITLE);

    // Drawn once: the view renders the title and then the summary from its
    // second line on, so a banner that appeared twice would mean the two had
    // come apart rather than that a line was repeated.
    const withSummary = feed([{ kind: "summary", lines: [RUN_TITLE, "  Run log: /state/runs.jsonl"] }]);
    const frameText = render(liveView(withSummary, frame())).lastFrame() ?? "";
    expect(frameText.split("\n").filter((l) => l.includes(RUN_TITLE))).toHaveLength(1);
    expect(frameText.split("\n")[0]).toContain(RUN_TITLE);
    expect(frameText).toContain("Run log: /state/runs.jsonl");
  });

  it("105-S54: an agent idle, then running, then idle again reflects each transition", () => {
    const idle = feed([{ kind: "configured", agent: "dev-bot-mdden" }]);
    expect(idle.agents).toEqual([{ agent: "dev-bot-mdden", state: "idle", note: null, queued: 0, claim: null, startedAt: null }]);

    const running = applyEvent(idle, {
      kind: "start",
      agent: "dev-bot-mdden",
      claim: "c1",
      unitKind: "file-arrived",
      seq: 8412,
      workspace: "01-ideas",
      file: "01-ideas/37-a-doctor-command.md",
      brain: "markdown brain",
      recordedAt: AT.toISOString(),
    }, AT);
    expect(running.agents[0]).toMatchObject({
      state: "running",
      note: "file-arrived #8412 · 01-ideas/37-a-doctor-command.md · markdown brain",
    });

    const back = applyEvent(running, { kind: "done", agent: "dev-bot-mdden", claim: "c1", ms: 1000, costUsd: 1, turns: 2, message: "Done." }, AT);
    expect(back.agents[0]).toMatchObject({ state: "idle", note: null });

    // Drawn rather than only held: the running row is the one that mounts the
    // spinner, so this is the only place anything renders one.
    const drawn = render(liveView(running, frame())).lastFrame() ?? "";
    expect(drawn).toContain("dev-bot-mdden");
    expect(drawn).toContain("file-arrived #8412 · 01-ideas/37-a-doctor-command.md · markdown brain");
  });

  it("105-S54: every value on screen comes from an event — the view has no clock and no state of its own", () => {
    // `applyEvent` is pure and total: the same events give the same screen, and
    // nothing but an event can move a value. The spinner's frame is the one
    // thing that is timer-driven, and it is Ink's rather than this state's.
    const events: RunEvent[] = [
      { kind: "configured", agent: "a" },
      { kind: "start", agent: "a", claim: "c", unitKind: "k", seq: 1, workspace: "w", file: null, brain: null, recordedAt: AT.toISOString() },
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

  it("105-S56: the recent-runs list starts empty, holds finished sessions newest first, and reads nothing off disk itself", () => {
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

    // The runner reads the log and hands the view its rows; the view never reads
    // it. Asserted against what the module can reach rather than against the
    // words in it, since the header names `runs.jsonl` to explain this. A type
    // from the log is not a reach.
    const source = readFileSync(fileURLToPath(new URL("../src/run/view.ts", import.meta.url)), "utf8");
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports.some((line) => /node:fs/.test(line) || (/\/log\.ts/.test(line) && !line.startsWith("import type ")))).toBe(false);
    expect(source).not.toMatch(/\b(readFile|readFileSync|appendRun|runLogPath)\s*\(/);
  });

  it("105-S57: without a TTY the output is the plain lines and no view is constructed", async () => {
    const plain = await drive({ isTTY: false });
    // Every line is a plain line: stamped, single-line, and with a known label.
    for (const line of plain.out.filter((l) => !l.startsWith(RUN_TITLE) && !l.startsWith("  "))) {
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
      { kind: "start", agent: "dev-bot-mdden", claim: "c1", unitKind: "file-arrived", seq: 1, workspace: "w", file: null, brain: null, recordedAt: AT.toISOString() },
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
      { kind: "start", agent: "a", claim: "c1", unitKind: "k", seq: 1, workspace: "w", file: null, brain: null, recordedAt: AT.toISOString() },
      { kind: "queued", agent: "a", depth: 2 },
    ]);
    expect(queued.agents[0]).toMatchObject({ state: "running", queued: 2 });
    const after = applyEvent(queued, { kind: "done", agent: "a", claim: "c1", ms: 1, costUsd: null, turns: null, message: "Done." }, AT);
    expect(after.agents[0].queued).toBe(1);
  });

  it("a tick-level skip changes nothing: the agent is already running, which is that fact said usefully", () => {
    const before = feed([
      { kind: "configured", agent: "a" },
      { kind: "start", agent: "a", claim: "c", unitKind: "k", seq: 1, workspace: "w", file: null, brain: null, recordedAt: AT.toISOString() },
    ]);
    expect(applyEvent(before, { kind: "skipped", agent: "a", reason: "a: a session is already running." }, AT)).toBe(before);
  });
});

describe("run: what the review found", () => {
  it("a session the runner stopped is its own outcome, not a failure and not a timeout", () => {
    const term = readOutcome(ending({ stoppedBy: "runner", signal: "term" }));
    expect(term.kind).toBe("stopped");
    expect(term.message).toContain("stopped before it finished");
    expect(readOutcome(ending({ stoppedBy: "runner", signal: "kill" })).message).toContain("killed");
    // A wall clock that fired wins: it is the more specific fact.
    expect(readOutcome(ending({ stoppedBy: "runner", timedOut: true, signal: "term" })).kind).toBe("timed-out");
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
    // 99-S11: the cheap action first. Every refusal on this path arrives under
    // `mdbrain run`, and it is the invocation that has been observed to succeed
    // straight after one, so recommending a login ahead of it is the wrong order.
    const shown = refused.err.join("\n");
    expect(shown.indexOf("mdbrain run")).toBeGreaterThan(-1);
    expect(shown.indexOf("mdbrain run")).toBeLessThan(shown.indexOf("mdbrain login"));
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
    const stoppers = new Set<import("../src/run/execute.ts").Stopper>();
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
    for (const stopper of [...stoppers]) stopper("stop");
    const ended = await running;
    expect(ended.stoppedBy).toBe("runner");
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
  it("APP_URL is the bare host, because `www.` redirects and a redirect drops the credential", async () => {
    const { APP_URL } = await import("../src/auth/project.ts");
    // Measured against production: https://www.markdownbrain.ai/api/agents
    // answers 308 to https://markdownbrain.ai/api/agents, and fetch strips
    // Authorization across that hop — so the route sees no bearer and refuses a
    // perfectly good token as though the person were signed out.
    expect(APP_URL).toBe("https://markdownbrain.ai");
  });

  it("MCP_URL is the server every connector grant is bound to, and the repository's own .mcp.json says the same", async () => {
    const { MCP_URL } = await import("../src/auth/project.ts");
    // The web app's NEXT_PUBLIC_MCP_URL and the server's MCP_PUBLIC_URL are set in
    // deployments, out of reach here; the checked-in .mcp.json is the copy that is not.
    // Only its own entry is compared, so a second, unrelated server there is no failure.
    expect(MCP_URL).toBe("https://mcp.markdownbrain.ai/mcp");
    const checkedIn = JSON.parse(readFileSync(fileURLToPath(new URL("../../../.mcp.json", import.meta.url)), "utf8")) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(checkedIn.mcpServers["markdownbrain"]?.url).toBe(MCP_URL);
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
        expect(signInAgainMessage((cause as InstanceType<typeof AuthError>).status, "mdbrain run")).toBeNull();
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
    expect(countdownText(waiting, NOW)).toBe("catch-up sweep in 4m12s");
    expect(countdownText(waiting, NOW + 251_000)).toBe("catch-up sweep in 1s");
    // A deadline the clock has already passed is a poll about to happen, not a
    // negative number: the loop is one turn away and the arithmetic is rounding.
    expect(countdownText(waiting, NOW + 300_000)).toBe("catch-up sweep due now");
    // The three strings above are the whole of the wording: at forty-five
    // minutes a countdown to *the next poll* reads as the only thing that is
    // going to happen, when the socket drawn above it is live and usually gets
    // there first.

    expect(countdownText(applyEvent(waiting, { kind: "phase", phase: { kind: "polling" } }, AT), NOW)).toBe("polling now");
    // A runner that has not said where it is says nothing rather than guessing.
    expect(countdownText(emptyView, NOW)).toBeNull();
    expect(render(liveView(waiting, frame())).lastFrame()).toContain("catch-up sweep in 4m12s");
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
    expect(render(liveView(finishing, frame())).lastFrame()).not.toContain("catch-up sweep in");
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
    expect(keyHints()).toContain("↑ or ↓ — pick a session");
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
    expect(plain.out.join("\n")).not.toContain("catch-up sweep in");
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
    // The first poll is at 12:00:01 and the deadline it sets is an interval on.
    expect(said[0]).toBe(new Date(2026, 8, 4, 12, 0, 1).getTime() + POLL_MS);
    // The key is pressed at 12:00:21, twenty seconds into that wait, and the
    // poll it causes lands at 12:00:22. **The next deadline is a whole interval
    // after that** — 12:45:22 — rather than the 12:45:01 an unreset interval
    // would have kept, which is the whole of what resetting means.
    expect(said[1]).toBe(new Date(2026, 8, 4, 12, 0, 22).getTime() + POLL_MS);
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
    const first = moveSelection(view, null, "older");
    expect(first).toBe("c2");
    expect(selectedRun(view.recent, first)!.message).toContain("no credential");

    // A run finishing pushes the list down; the selection is still the same run.
    const after = applyEvent(view, { kind: "done", agent: "a", claim: "c3", ms: 5, costUsd: null, turns: null, message: "Third." }, AT);
    expect(after.recent[0].claim).toBe("c3");
    expect(selectedRun(after.recent, first)!.claim).toBe("c2");

    expect(moveSelection(view, "c2", "older")).toBe("c1");
    // The oldest is the end of the list rather than a wrap.
    expect(moveSelection(view, "c1", "older")).toBe("c1");
    // Up off the top leaves the list, so closing needs no second key learnt.
    expect(moveSelection(view, "c2", "newer")).toBeNull();
    expect(moveSelection(view, "c1", "clear")).toBeNull();
    // A selected run that has fallen out of the window resolves to nothing
    // rather than to whatever now sits at its index.
    expect(selectedRun(view.recent, "gone")).toBeNull();
    expect(moveSelection(emptyView, null, "older")).toBeNull();
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
          return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null };
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
    const { sessionNotAcceptedMessage } = await import("../src/auth/session.ts");
    // The real sentence rather than a stand-in, so this composes what an operator
    // is actually shown: the wording and the suffix are printed as one line.
    const said = sessionNotAcceptedMessage("mdbrain run");

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
      attended: [],
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

describe("run: a runner the server will not let start", () => {
  // `sent` is deliberately not this build's own version: the two differ exactly
  // when something in transit removed the header, and a fixture where they agree
  // cannot tell a row that records the server's account from one that re-derives
  // it here — which is the whole reason the row carries both.
  const refusing = { status: 426, sent: "0.2.0", said: "This mdbrain is too old for this server. It reported 0.2.0, and the oldest this server accepts is 0.4.0.", minimum: "0.4.0" };

  it("128-S1: the refusal names both versions, the remedy for this install, and the restart caveat", async () => {
    const { RUNNING_RUN_NOTICE } = await import("../src/upgrade/plan.ts");
    const refused = await drive({
      askToStart: async () => refusing,
      build: { version: "0.3.0", channel: "direct", isCompiled: true },
    });
    const said = refused.err.join("\n");
    expect(said).toContain("too old");
    expect(said).toContain("0.2.0");
    expect(said).toContain("0.4.0");
    expect(said).toContain("mdbrain upgrade");
    expect(said).toContain(RUNNING_RUN_NOTICE);
    // Nothing was asked for and nothing was started: the refusal is the
    // process boundary, not a tick that happened to fail.
    expect(refused.spawned).toEqual([]);
  });

  it("128-S2: it is never reported as a session problem", async () => {
    const refused = await drive({
      askToStart: async () => refusing,
      build: { version: "0.3.0", channel: "direct", isCompiled: true },
    });
    const said = refused.err.join("\n").toLowerCase();
    // Asserted before the absences, so a refusal that never happened cannot
    // pass this by leaving the stream empty.
    expect(said).toContain("too old");
    expect(said).not.toContain("login");
    expect(said).not.toContain("sign in");
    expect(said).not.toContain("session");
  });

  it("128-S7: a packaged install is told its own packager's command", async () => {
    const packaged = await drive({
      askToStart: async () => refusing,
      build: { version: "0.3.0", channel: "homebrew", isCompiled: true },
    });
    expect(packaged.err.join("\n")).toContain("brew upgrade");
    expect(packaged.err.join("\n")).not.toContain("Run \`mdbrain upgrade\`");
  });

  it("128-S8: a row of its own kind holds the floor and the version sent, and the exit is non-zero", async () => {
    const refused = await drive({
      askToStart: async () => refusing,
      build: { version: "0.3.0", channel: "direct", isCompiled: true },
    });
    expect(refused.code).toBe(1);
    // The socket is given up on the way out: a refused start is an ending, and
    // this process drains the event loop rather than calling `process.exit`.
    expect(refused.presence.closes()).toBe(1);
    const rows = refused.notes as unknown as Array<Record<string, unknown>>;
    const row = rows.find((note) => note.kind === "too-old");
    // `received` is the server's account of what arrived and `version` is this
    // build's own; the fixture keeps them apart so neither can stand in for the
    // other, which is the case the row exists to make readable.
    expect(row).toMatchObject({ kind: "too-old", version: "0.3.0", received: "0.2.0", minimum: "0.4.0", said: "This mdbrain is too old for this server. It reported 0.2.0, and the oldest this server accepts is 0.4.0." });
    // The start row is still written first — the refusal is an ending, and an
    // ending with nothing before it is the one shape this file exists to avoid.
    expect(rows[0]).toMatchObject({ kind: "start" });
    // `refused` means the session went. This is not that, and a reader who
    // could not tell them apart would be sent to re-authenticate.
    expect(rows.some((note) => note.kind === "refused")).toBe(false);
    expect(rows.some((note) => note.kind === "stop")).toBe(false);
  });

  it("128-S4: a gate that cannot be asked starts the run", async () => {
    for (const askToStart of [
      async () => {
        throw new Error("fetch failed");
      },
      async () => ({ status: 500, said: "Upstream error", minimum: null, sent: null }),
      async () => ({ status: 404, said: "Not Found", minimum: null, sent: null }),
    ]) {
      const started = await drive({ askToStart });
      expect(started.code).toBe(0);
      expect(started.spawned).toHaveLength(1);
      expect((started.notes as unknown as Array<Record<string, unknown>>).some((note) => note.kind === "too-old")).toBe(false);
    }
  });

  it("128-S4: and the run that was let through is not told anything about it", async () => {
    const quiet = await drive({
      askToStart: async () => {
        throw new Error("fetch failed");
      },
    });
    // Silence on a failed lookup, exactly as the version notice is silent: a
    // check nobody asked for must not become a permanent complaint on screen.
    expect(quiet.out.join("\n")).not.toContain("fetch failed");
    expect(quiet.err.join("\n")).not.toContain("fetch failed");
  });

  it("128-S5: a server with no floor set refuses nobody", async () => {
    const started = await drive({ askToStart: async () => ({ status: 200, said: "", minimum: null, sent: "0.1.0" }) });
    expect(started.code).toBe(0);
    expect(started.spawned).toHaveLength(1);
  });

  it("128-S3: the question is asked once, before the first poll, and never per tick", async () => {
    const asks: string[] = [];
    let reads = 0;
    // Several ticks rather than one. Under `--once` a question asked at startup
    // and a question asked every tick both come to exactly one call, so the
    // count cannot tell the two apart — which is the difference the floor rests
    // on. The run is ended by the session read the loop already takes.
    await drive(
      {
        session: async () => {
          reads += 1;
          return reads < 5
            ? { kind: "ready" as const, accessToken: `token-${reads}` }
            : { kind: "stop" as const, reason: "sign-in", message: "Sign in with `mdbrain login`." };
        },
        askToStart: async (token: string) => {
          asks.push(token);
          return { status: 200, said: "", minimum: null, sent: "0.1.0" };
        },
      },
      { once: false },
    );
    // The loop really did come round again: without this the case below is
    // satisfied by a run that never reached a second tick.
    expect(reads).toBeGreaterThan(2);
    // One call, and it carries the token the startup read handed over.
    expect(asks).toEqual(["token-1"]);
  });
});

describe("run: where the two connections stand, on both presenters", () => {
  const NOW = new Date(2026, 8, 4, 12, 4, 1).getTime();
  const frame = (over: Partial<ScreenFrame> = {}): ScreenFrame => ({ now: NOW, keysActive: true, selection: null, ...over });
  const feed = (events: RunEvent[]) => events.reduce((state, event) => applyEvent(state, event, AT), emptyView);
  const STATES = ["connected", "retrying", "unavailable"] as const;
  const LISTENING = ["listening", "partial", "retrying", "unavailable", "silent"] as const;
  // Ink wraps at the frame's width, and the run log's sentences are longer than
  // that — so a drawn line arrives split across rows, with the frame's own
  // border and its colour escapes spliced into the middle of it. A comparison
  // against a sentence fails on a screen that is perfectly right, which is why
  // the border and the escapes come out before the whitespace is collapsed.
  // Removing them only ever makes a `not.toContain` harder to satisfy, so
  // nothing below is weakened by it.
  const flat = (text: string | undefined) =>
    (text ?? "")
      .replace(new RegExp("\\u001b\\[[0-9;]*m", "g"), "")
      .replace(/[│┌┐└┘─]/g, " ")
      .replace(/\s+/g, " ");
  const listening = (state: (typeof LISTENING)[number], held = 1, total = 2): RunEvent => ({ kind: "listening", state, held, total });

  it("121-S11: the run log still carries the full sentence for both sockets, in channel.ts's own words", async () => {
    const { connectionText, listeningText } = await import("../src/run/channel.ts");
    // The surface the shortening is deliberately kept away from: this is the
    // file somebody greps when a runner has gone quiet overnight, and it is the
    // one place the long sentence earns its length.
    for (const state of STATES) {
      const line = plainLine({ at: AT, event: { kind: "connection", state } });
      expect(line).toContain(connectionText(state));
      expect(line).toContain("presence");
    }
    for (const state of LISTENING) {
      const line = plainLine({ at: AT, event: listening(state) });
      expect(line).toContain(listeningText(state, 1, 2));
      expect(line).toContain("listening");
    }
  });

  it("121-S25: green is the live link, and nothing else the screen can draw uses it", () => {
    expect(connectionRow({ state: "listening", held: 1, total: 1 }, "connected")?.color).toBe(LIVE_COLOR);
    expect(LIVE_COLOR).toBe("green");
    // Every other colour this screen can emit, gathered from the one place each
    // is named: a green anywhere in here is the row that matters losing the only
    // thing that made it findable at a glance.
    expect([ACTIVE_COLOR, SETTLED_COLOR, FAILED_COLOR, ...Object.values(STATE_COLOR)]).not.toContain(LIVE_COLOR);
    // The list above can only see the colours this module exports, and two of
    // the ones it draws are private to it: the frame — every heading, the title
    // and the countdown — and the version notice. Either turned green floods the
    // screen with the colour this rule reserves, and neither is reachable from
    // any name a test can import. So the claim in this case's title is held by a
    // count over the source instead, with the comments taken out first, because
    // the paragraph above LIVE_COLOR argues about green at length and a scan a
    // comment can satisfy is not a scan.
    const source = readFileSync(fileURLToPath(new URL("../src/run/screen.ts", import.meta.url)), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    // The strip is an instrument too, and a strip that quietly did nothing would
    // make every count below pass for the wrong reason.
    expect(source).toContain("Green means the live link");
    expect(code).not.toContain("Green means the live link");
    // Twice, and both of them declarations: the constant, and the connection
    // row's own type, which is where green is made legal rather than used.
    expect(code.match(/"green"/g) ?? []).toHaveLength(2);
    expect(code).toContain('export const LIVE_COLOR = "green"');
    expect(code).toContain('color: "green" | "yellow" | "red"');
  });

  it("121-S25: on a screen drawing every coloured thing at once, the only green is the connection row", () => {
    // The case above reads the module's text, so it sees a green SPELLED
    // anywhere in it — including the two colours no name exports. It cannot see
    // a site drawn in the live colour by NAME, which spells nothing and is the
    // same wrong screen. This asks the other question: of everything actually
    // drawn, what came out green?
    const colours = (node: unknown, found: { color: string; text: string }[] = []) => {
      if (node === null || typeof node !== "object") return found;
      if (Array.isArray(node)) {
        for (const child of node) colours(child, found);
        return found;
      }
      const props = (node as { props?: Record<string, unknown> }).props;
      if (props === undefined) return found;
      if (typeof props.color === "string") found.push({ color: props.color, text: String(props.children ?? "") });
      colours(props.children, found);
      return found;
    };

    const started = (agent: string, claim: string): RunEvent => ({
      kind: "start", agent, claim, unitKind: "file-arrived", seq: 1, workspace: "w", file: null, brain: null,
      recordedAt: AT.toISOString(),
    });
    const view = feed([
      { kind: "configured", agent: "idle-one" },
      { kind: "configured", agent: "working" },
      { kind: "configured", agent: "ran-twice" },
      { kind: "configured", agent: "stuck" },
      { kind: "held", agent: "stuck", reason: "STUCK_KEY is not set." },
      started("working", "c-live"),
      started("ran-twice", "c-done"),
      { kind: "done", agent: "ran-twice", claim: "c-done", ms: 5_000, costUsd: 0.4, turns: 3, message: "Done." },
      started("ran-twice", "c-failed"),
      { kind: "failed", agent: "ran-twice", claim: "c-failed", outcome: "failed", ms: 2_000, message: "It did not." },
      { kind: "version", version: "0.9.9", how: "Run `mdbrain upgrade` to replace it." },
      { kind: "connection", state: "connected" },
      listening("listening", 2, 2),
    ]);
    // The picked run draws the detail block as well, so every site this state
    // can reach is on the one screen being read.
    const drawn = colours(liveView(view, frame({ selection: "c-done" })));

    const greens = drawn.filter((node) => node.color === LIVE_COLOR);
    expect(greens).toHaveLength(1);
    expect(greens[0].text).toContain("listening for work");
    // The control: a walk that reached nothing would satisfy the line above.
    const seen = new Set(drawn.map((node) => node.color));
    expect(seen).toContain(ACTIVE_COLOR);
    expect(seen).toContain(SETTLED_COLOR);
    expect(seen).toContain(FAILED_COLOR);
  });

  it("121-S25: an agent working and a run that finished are told apart by colour, not only by position", () => {
    // They were one colour, so a screen with either on it read the same. Sharing
    // one again would put activity and history back in the same bucket.
    expect(STATE_COLOR.running).not.toBe(SETTLED_COLOR);
    expect(STATE_COLOR.running).not.toBe(STATE_COLOR.idle);
    expect(SETTLED_COLOR).not.toBe(FAILED_COLOR);
  });

  it("121-S7: presence connected and the socket listening draws one green row saying it is listening for work", () => {
    const view = feed([{ kind: "configured", agent: "a" }, { kind: "connection", state: "connected" }, listening("listening", 2, 2)]);
    expect(connectionRow(view.listening, view.connection)).toEqual({ color: "green", text: "listening for work", presence: null });

    const drawn = flat(render(liveView(view, frame())).lastFrame());
    expect(drawn).toContain("● listening for work");
    // The healthy row says what it is listening FOR and not how many it holds:
    // the count is the half a reader deciding whether the runner works is not
    // asking about, and every state where it means something still carries it.
    expect(drawn).not.toContain("2 brains");
    // One row where there were two: the presence sentence is not drawn beside it.
    expect(drawn).not.toContain("agents will appear in a brain's roster");
    expect((drawn.match(/●/g) ?? []).length).toBe(1);
  });

  it("121-S8: presence unavailable costs the row a clause and never its colour", () => {
    for (const state of ["retrying", "unavailable"] as const) {
      const view = feed([{ kind: "configured", agent: "a" }, { kind: "connection", state }, listening("listening", 2, 2)]);
      // The colour belongs to the consequence the row is about. Reddening the
      // work-signal light for a presence failure would say the more expensive
      // thing had happened.
      expect(connectionRow(view.listening, view.connection)).toEqual({
        color: "green",
        text: "listening for work",
        presence: "presence down",
      });
      expect(flat(render(liveView(view, frame())).lastFrame())).toContain("● listening for work · presence down");
    }
  });

  it("121-S9: an unhealthy socket is coloured as a notice and says work is arriving by poll", () => {
    const expected = {
      retrying: { color: "yellow", text: "reconnecting · polling only" },
      unavailable: { color: "red", text: "not listening · polling only" },
      silent: { color: "red", text: "no brains to listen to · polling only" },
    } as const;
    for (const [state, row] of Object.entries(expected)) {
      const view = feed([{ kind: "configured", agent: "a" }, listening(state as (typeof LISTENING)[number], 0, 0)]);
      expect(connectionRow(view.listening, view.connection)).toEqual({ ...row, presence: null });
      // The word rather than the colour, because a terminal that drops colour is
      // exactly where this row is most likely to be read — a piped run, a CI log.
      expect(flat(render(liveView(view, frame())).lastFrame())).toContain(`● ${row.text}`);
    }
  });

  it("121-S10: a partly held socket says how many of how many brains", async () => {
    const view = feed([{ kind: "configured", agent: "a" }, listening("partial", 1, 2)]);
    expect(connectionRow(view.listening, view.connection)).toEqual({ color: "yellow", text: "listening · 1 of 2 brains", presence: null });
    expect(flat(render(liveView(view, frame())).lastFrame())).toContain("● listening · 1 of 2 brains");
    // The singular left this row with the healthy count, and it did not leave a
    // gap behind: `partial` needs one brain held and one not, so its total is
    // never one and `listening · 1 of 1 brain` is unreachable rather than
    // untested. Asserted against the state machine itself, because that is what
    // makes the plural above a fact instead of the case somebody happened to pick.
    const { aggregateListening } = await import("../src/run/channel.ts");
    expect(aggregateListening({ held: 1, total: 1, everOpen: true, settled: true })).toBe("listening");
    // The rule rather than the five strings: `polling only` is carried by
    // exactly the states where no signal can arrive. `listening` and `partial`
    // hold rooms, so signals do still reach them and the phrase would be false;
    // the other three can receive none. Driven over the whole of LISTENING and
    // asserted in both directions, so a state added to the vocabulary without a
    // decision about this fails here rather than quietly inheriting whichever
    // answer its own text happens to give.
    const holdsRooms = new Set(["listening", "partial"]);
    for (const state of LISTENING) {
      const text = connectionRow({ state, held: 1, total: 2 }, null)?.text ?? "";
      expect([state, text.includes("polling only")]).toEqual([state, !holdsRooms.has(state)]);
    }
  });

  it("117-S28: a runner that is not listening says so until it is, and the note cannot erase it", () => {
    const deaf = feed([{ kind: "configured", agent: "a" }, listening("silent", 0, 0)]);

    // Every sender that owns the single `note` slot. None of them reaches this
    // row, which is the whole reason it is not a note — a runner left up for
    // days would otherwise lose it to the first of them to fire.
    const battered = [
      { kind: "note", message: "a renamed agent" },
      { kind: "note", message: "the count could not be read" },
      { kind: "poll", agents: ["a"], waiting: 0 },
      { kind: "asked", taken: true, reason: null },
    ].reduce((state, event) => applyEvent(state, event as RunEvent, AT), deaf);
    expect(flat(render(liveView(battered, frame())).lastFrame())).toContain("● no brains to listen to · polling only");

    // And it goes away by being replaced, which is the transition the whole row
    // exists to make visible: the runner found a brain and is now being told.
    const heard = applyEvent(battered, listening("listening", 2, 2), AT);
    const drawn = flat(render(liveView(heard, frame())).lastFrame());
    expect(drawn).toContain("● listening for work");
    expect(drawn).not.toContain("no brains to listen to");
  });

  it("117-S25: says nothing at all until the runner has, since silence is not unavailable", () => {
    expect(emptyView.listening).toBeNull();
    expect(emptyView.connection).toBeNull();
    // **Presence alone draws nothing, including when it is unhealthy**, and that
    // is the consequence of it being a clause rather than a row: there is nowhere
    // for it to land until the runner has said where it is listening, and
    // inventing a mark and a word for a presence-only row would be the screen
    // deciding something the spec's vocabulary does not cover. `run` says a
    // listening state before its first tick either way, so the window is
    // milliseconds — but it is a window, and this is where it is written down.
    for (const state of STATES) expect(connectionRow(null, state)).toBeNull();

    const quiet = flat(render(liveView(feed([{ kind: "configured", agent: "a" }]), frame())).lastFrame());
    // The control that makes the absence mean something: this frame is drawn and
    // does hold the agent's row, so it is a frame that could have carried a light.
    expect(quiet).toContain("a idle");
    expect(quiet).not.toContain("●");
  });

  it("the reducer keeps the state and its counts rather than a composed sentence", async () => {
    const { listeningText } = await import("../src/run/channel.ts");
    for (const state of LISTENING) {
      const seen = applyEvent(emptyView, listening(state, 1, 2), AT);
      expect(seen.listening).toEqual({ state, held: 1, total: 2 });
      // The property that made it safe to stop composing here: the screen's own
      // vocabulary is a pure function, so none of the run log's wording leaks on
      // to it and nothing about either surface needs a terminal to assert.
      expect(connectionRow(seen.listening, null)?.text).not.toBe(listeningText(state, 1, 2));
    }
  });
});

describe("run: work that arrives without being asked for", () => {
  it("listens to the brains it was told about, on the project's own socket", async () => {
    const driven = await drive({ listenTo: async () => ["brain-1", "brain-2"] });
    const opened = driven.signals.opened();
    expect(opened?.brains).toEqual(["brain-1", "brain-2"]);
    expect(opened?.url).toContain("realtime/v1/websocket");
    expect(driven.signals.closes()).toBe(1);
  });

  it("117-S28: a runner that learned no brains says it is not listening, rather than looking like a quiet brain", async () => {
    const { listeningText } = await import("../src/run/channel.ts");
    const deaf = await drive({ listenTo: async () => [] });
    expect(deaf.signals.opened()).toBeNull();
    // The line is the runner's own here: there is no link to report it, which is
    // exactly the case that was indistinguishable from nothing happening.
    expect(deaf.out.join("\n")).toContain(listeningText("silent", 0, 0));
  });

  it("117-S27: the link's own states reach the presenter, so a refused room is visible", async () => {
    const { listeningText } = await import("../src/run/channel.ts");
    const driven = await drive({
      openSignals: (options) => {
        options.onState?.("partial", 1, 2);
        return { refresh: () => {}, close: () => {} };
      },
    });
    expect(driven.out.join("\n")).toContain(listeningText("partial", 1, 2));
  });

  it("asks about the agents it will actually be asking for work", async () => {
    const asked: string[][] = [];
    await drive({
      listenTo: async (_token, agents) => {
        asked.push([...agents]);
        return [];
      },
    });
    // Asked more than once, because an answer of no brains is the one every
    // failure on this path gives and is not taken as final. What is pinned here
    // is who is asked about, and that is the same set every time.
    expect(asked.length).toBeGreaterThan(0);
    for (const agents of asked) expect(agents).toEqual(["dev-bot-mdden"]);
  });

  // The safety net, stated where it would break: neither failure on this path may
  // cost a claim, because the poll is what actually finds work.
  it("117-S16: a brain list that cannot be read leaves a runner that still claims and runs, and says it is deaf", async () => {
    const { listeningText } = await import("../src/run/channel.ts");
    const driven = await drive({
      listenTo: async () => {
        throw new Error("refused");
      },
    });
    expect(driven.code).toBe(0);
    expect(driven.spawned).toHaveLength(1);
    expect(driven.signals.opened()).toBeNull();
    // Surviving the failure was always the rule; saying so is what was missing,
    // and it is the difference between a degraded runner and a quiet brain.
    expect(driven.out.join("\n")).toContain(listeningText("silent", 0, 0));
  });

  it("117-S16: a socket that is up and silent costs latency and not work", async () => {
    // The link is opened and never fires: the unit is claimed and run anyway,
    // which is the whole of the property the poll exists to keep.
    const driven = await drive();
    expect(driven.code).toBe(0);
    expect(driven.spawned).toHaveLength(1);
  });

  it("hands the listening socket the same fresh token the presence one gets", async () => {
    const driven = await drive({ session: async () => ({ kind: "ready", accessToken: "token-2" }) });
    expect(driven.signals.refreshed).toEqual(driven.presence.refreshed);
    expect(driven.signals.refreshed).toContain("token-2");
  });
});

describe("run: a signal ends the wait the loop is sitting in", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a signal for work that is not claimable yet ends the wait at the moment it becomes claimable", async () => {
    vi.useFakeTimers();
    const { AuthError } = await import("../src/auth/api.ts");
    let fire: ((dueInMs: number) => void) | null = null;
    let counts = 0;
    let waits = 0;
    const running = drive(
      {
        openSignals: (options) => {
          fire = options.onSignal;
          return { refresh: () => {}, close: () => {} };
        },
        sleep: (_ms, stop) =>
          new Promise<void>((resolve) => {
            waits += 1;
            stop.wake = () => resolve();
          }),
        count: async () => {
          counts += 1;
          if (counts >= 2) throw new AuthError(401, "that is enough");
          return { waiting: 0, capped: false };
        },
      },
      { once: false },
    );

    for (let i = 0; i < 20 && waits === 0; i++) await vi.advanceTimersByTimeAsync(1);
    expect(counts).toBe(1);

    // A mention: its row opens now and is claimable a minute from now. Reading at
    // once would find nothing, and — since the moment it becomes claimable has no
    // write of its own to announce it — nothing would ever look again.
    fire!(60_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(counts).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    const driven = await running;
    expect(counts).toBe(2);
    expect(driven.code).toBe(1);
  });

  it("work claimable now is not delayed by a later prediction, and the later one still gets its read", async () => {
    vi.useFakeTimers();
    const { AuthError } = await import("../src/auth/api.ts");
    let fire: ((dueInMs: number) => void) | null = null;
    const at: number[] = [];
    let clock = 0;
    const running = drive(
      {
        now: () => new Date(clock),
        openSignals: (options) => {
          fire = options.onSignal;
          return { refresh: () => {}, close: () => {} };
        },
        sleep: (_ms, stop) =>
          new Promise<void>((resolve) => {
            stop.wake = () => resolve();
          }),
        count: async () => {
          at.push(clock);
          if (at.length >= 3) throw new AuthError(401, "that is enough");
          return { waiting: 0, capped: false };
        },
      },
      { once: false },
    );

    for (let i = 0; i < 20 && at.length === 0; i++) await vi.advanceTimersByTimeAsync(1);

    // A file arriving (claimable now) and a mention (claimable in a minute), in
    // that order. The first must not be held back to wait for the second, and the
    // second must not be folded into the first's read and lost.
    fire!(0);
    fire!(60_000);

    clock = SIGNAL_DEBOUNCE_MS;
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    expect(at).toHaveLength(2);

    // The re-armed read is floored a minimum gap after the one just taken, so the
    // second lands at the later of that floor and the moment it predicted.
    clock = 60_000 + SIGNAL_MIN_GAP_MS;
    await vi.advanceTimersByTimeAsync(60_000 + SIGNAL_MIN_GAP_MS);
    const driven = await running;
    expect(at).toHaveLength(3);
    expect(driven.code).toBe(1);
  });

  // Driven through the command rather than through the debounce, because the
  // property is not "a timer fired" but "the loop polled when it would otherwise
  // have been asleep" — and the wait here is the real one: it ends only on a wake.
  it("117-S14: forty signals inside the window end the wait once", async () => {
    vi.useFakeTimers();
    const { AuthError } = await import("../src/auth/api.ts");
    let fire: ((dueInMs: number) => void) | null = null;
    let counts = 0;
    let waits = 0;
    const running = drive(
      {
        openSignals: (options) => {
          fire = options.onSignal;
          return { refresh: () => {}, close: () => {} };
        },
        sleep: (_ms, stop) =>
          new Promise<void>((resolve) => {
            waits += 1;
            stop.wake = () => resolve();
          }),
        count: async () => {
          counts += 1;
          // The second poll is the one the signal caused, and throwing here is
          // how this run ends without a stop it has no way to send itself.
          if (counts >= 2) throw new AuthError(401, "that is enough");
          return { waiting: 0, capped: false };
        },
      },
      { once: false },
    );

    // Let the first tick run and the loop reach its wait.
    for (let i = 0; i < 20 && waits === 0; i++) await vi.advanceTimersByTimeAsync(1);
    expect(counts).toBe(1);
    expect(fire).not.toBeNull();

    for (let i = 0; i < 40; i++) fire!(0);
    // Nothing yet: the read is armed, not taken.
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS - 1);
    expect(counts).toBe(1);

    await vi.advanceTimersByTimeAsync(2);
    const driven = await running;
    expect(counts).toBe(2);
    expect(waits).toBe(1);
    expect(driven.code).toBe(1);
  });

  // On the real clock, because the point is a read that must not be taken and a
  // fake clock would only show a timer this test declined to advance.
  //
  // **This is the case for both stop guards at once, and it has to be.** The
  // handler asks `stopping()` before arming and the read it arms asks again
  // before taking; either one alone absorbs a signal that lands after the run,
  // so removing either alone changes nothing anybody can observe and no case can
  // honestly red. Removing the pair is what costs something — a read taken and a
  // loop woken after the run has ended — and that is what this asserts. The
  // predicate is one named function for the same reason: two copies of one
  // condition are what makes a half-deletion look safe.
  //
  // **`wakes` is the assertion that carries the guards.** No read can be taken
  // here whatever they do: the run is over, so there is no loop for a woken
  // sleep to return into and `count()` is unreachable — `counts` holds under
  // every neuter of the pair. What the guards prevent is the wake, so `wakes` is
  // the half that reds when both go. `counts` is kept because it is still true
  // and is the half the name promises, not because it watches anything.
  it("a signal that lands after the run has ended takes no read and wakes nobody", async () => {
    const { AuthError } = await import("../src/auth/api.ts");
    let fire: ((dueInMs: number) => void) | null = null;
    let counts = 0;
    let waits = 0;
    let wakes = 0;
    const running = drive(
      {
        openSignals: (options) => {
          fire = options.onSignal;
          return { refresh: () => {}, close: () => {} };
        },
        sleep: (_ms, stop) =>
          new Promise<void>((resolve) => {
            waits += 1;
            stop.wake = () => {
              wakes += 1;
              resolve();
            };
            // The poll interval simply elapsing, which is how this run reaches
            // its second tick without a signal. It matters that no signal caused
            // a read here: the rate floor is thirty seconds, so a signal-driven
            // read would absorb the case's own signal before either guard was
            // asked anything, and the case would pass with the guards deleted.
            setTimeout(resolve, 0);
          }),
        count: async () => {
          counts += 1;
          if (counts >= 2) throw new AuthError(401, "that is enough");
          return { waiting: 0, capped: false };
        },
      },
      { once: false },
    );

    const driven = await running;
    expect(driven.code).toBe(1);
    expect(waits).toBeGreaterThan(0);
    expect(fire).not.toBeNull();
    const took = counts;
    const woke = wakes;

    fire!(0);
    await new Promise((r) => setTimeout(r, SIGNAL_DEBOUNCE_MS + 500));
    expect(counts).toBe(took);
    expect(wakes).toBe(woke);
  }, 20_000);
});

describe("run: what the signal path may not cost", () => {
  // On the real clock deliberately: the point is that the ceiling holds against a
  // dependency that honours nothing — neither resolving nor observing the abort —
  // and a fake clock would only prove that a timer this test advanced fired.
  it("a brain list that never answers does not stall the first poll", async () => {
    const driven = await drive({
      // A request that hangs, which is what a wedged server looks like from here.
      listenTo: () => new Promise<string[]>(() => {}),
    });
    expect(driven.code).toBe(0);
    expect(driven.spawned).toHaveLength(1);
    // Nothing to listen to, and the run went on regardless.
    expect(driven.signals.opened()).toBeNull();
  }, 20_000);

  // The same ceiling as the lookup above, and a stronger claim: that one is
  // waited for and bounded, this one is not waited for at all. What it buys is a
  // field on a line, so it must not be able to cost the first poll a millisecond.
  it("121-S16: a brain-name read that never answers does not stall the first poll", async () => {
    const started = Date.now();
    const driven = await drive({
      // A request that hangs and observes nothing — neither resolving nor
      // honouring the abort, which is what a wedged server looks like from here.
      nameBrains: () => new Promise<Map<string, string>>(() => {}),
    });
    expect(driven.code).toBe(0);
    expect(driven.spawned).toHaveLength(1);
    // Comfortably under the 5s bound the read is held to, which is the number a
    // version that waited for it would land just past.
    expect(Date.now() - started).toBeLessThan(2_000);
    // And the session that ran named no brain, which is the accepted state.
    expect(driven.out.join("\n")).toContain("start");
  }, 20_000);

  it("121-S24: a run that has printed its last line abandons the name request rather than holding the process open", async () => {
    let handed: AbortSignal | null = null;
    const started = Date.now();
    const driven = await drive({
      nameBrains: (_token, _ids, signal) => {
        handed = signal ?? null;
        // Never answers and never gives up on its own: the only thing that can
        // end this request is somebody aborting it.
        return new Promise<Map<string, string>>(() => {});
      },
    });
    expect(driven.code).toBe(0);
    expect(handed).not.toBeNull();
    // The timer that bounds the *wait* would also abort this, five seconds in —
    // so the assertion is worth nothing unless the run finished well short of
    // it. Aborted by then means the run's own ending did it.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(handed!.aborted).toBe(true);
  }, 20_000);

  it("the roster read that could not be made redacts what answered it", async () => {
    const driven = await drive({
      roster: async () => {
        // A gateway echoing the request it could not forward, which is the shape
        // that carries the bearer back out onto somebody's terminal.
        throw new Error("upstream refused: Authorization: Bearer abc123def456ghi");
      },
    });
    const said = driven.err.join("\n");
    expect(said).toContain("Could not read the roster");
    expect(said).toContain("[redacted]");
    expect(said).not.toContain("abc123def456ghi");
  });
});

describe("run: the line that names the work", () => {
  const start = (over: Partial<Extract<RunEvent, { kind: "start" }>> = {}): RunEvent => ({
    kind: "start",
    agent: "dev-bot-mdden",
    claim: "3f2a1111-aaaa",
    unitKind: "file-changed",
    seq: 7,
    workspace: "96c4b572-7b22-44ea-8596-84b05e46d5c5",
    file: "04-specs/117-a-socket-the-runner-holds.md",
    brain: "markdown brain",
    recordedAt: AT.toISOString(),
    ...over,
  });
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  const noteFor = (event: RunEvent) =>
    applyEvent(applyEvent(emptyView, { kind: "configured", agent: "dev-bot-mdden" }, AT), event, AT).agents[0].note;

  it("121-S12: a unit naming a file reads as the kind, the sequence, the path and the brain — and no UUID", () => {
    expect(noteFor(start())).toBe("file-changed #7 · 04-specs/117-a-socket-the-runner-holds.md · markdown brain");
    expect(noteFor(start())).not.toMatch(UUID);
    expect(noteFor(start({ unitKind: "file-arrived", file: "01-ideas/71-agent-runner-revision.md" }))).toBe(
      "file-arrived #7 · 01-ideas/71-agent-runner-revision.md · markdown brain",
    );
  });

  it("121-S13: a mention names no file, which is a ruling rather than a gap", () => {
    // Mentions coalesce, so one wake can stand for five comments and there is no
    // single thread to name even in principle. The line is the kind, the seq and
    // the brain.
    expect(noteFor(start({ unitKind: "agent-mentioned", file: null }))).toBe("agent-mentioned #7 · markdown brain");
  });

  it("121-S14: a brain the runner has no name for costs the name and nothing else — the UUID does not come back", () => {
    const note = noteFor(start({ brain: null }));
    expect(note).toBe("file-changed #7 · 04-specs/117-a-socket-the-runner-holds.md");
    // The whole point of the change: there is no fallback to the id, in any state.
    expect(note).not.toMatch(UUID);
    expect(noteFor(start({ brain: null, file: null }))).toBe("file-changed #7");
  });

  it("121-S15: the run log keeps the workspace id and gains the path", () => {
    // The opposite trade from the screen's, for the opposite reader: a log line
    // is correlated against the database later, where an id is the only thing
    // that joins, and a screen is read now, where a name is.
    const line = plainLine({ at: AT, event: start() })!;
    expect(line).toContain("96c4b572-7b22-44ea-8596-84b05e46d5c5");
    expect(line).toContain("04-specs/117-a-socket-the-runner-holds.md");
    expect(line).toContain("file-changed #7");
    // The brain's name is the screen's half and is deliberately not here.
    expect(line).not.toContain("markdown brain");
    // A unit with no file leaves the line exactly the shape it already had.
    expect(plainLine({ at: AT, event: start({ file: null }) })!).toMatch(/96c4b572-7b22-44ea-8596-84b05e46d5c5$/);
  });

  it("121-S16: the names are read once for the whole set, and a read that fails still starts the session", async () => {
    const driven = await drive({ listenTo: async () => ["brain-1", "brain-2"] });
    // The ids the listen lookup came back with reach the read, whole.
    expect(driven.nameAsks).toEqual([["brain-1", "brain-2"]]);

    // And the read itself makes one request for the set, which the stand-in
    // above cannot see: it records the ids it was handed and never calls
    // anything. Driven here against the real function, since *one read for the
    // whole set* is a claim about the request rather than about the caller.
    const { listWorkspaceNames } = await import("../src/auth/api.ts");
    const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), signal: init?.signal });
      return Promise.resolve(
        new Response(JSON.stringify([{ id: "brain-1", name: "markdown brain" }, { id: "brain-2", name: "" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    try {
      const names = await listWorkspaceNames("t", ["brain-1", "brain-2", "brain-1", ""]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("workspaces?select=id,name&id=in.(brain-1,brain-2)");
      // A name that came back empty is absent rather than blank, so the line
      // drops the name — 121-S14's state — rather than ending in a separator.
      expect([...names]).toEqual([["brain-1", "markdown brain"]]);

      // No ids is no request at all.
      calls.length = 0;
      expect(await listWorkspaceNames("t", [])).toEqual(new Map());
      expect(calls).toHaveLength(0);

      // The caller's bound has to reach `fetch`. `run` arms an abort on this
      // read precisely so an abandoned request cannot hold the process open
      // past its last printed line, and a signal that stops at the helper
      // cancels nothing while looking exactly like one that works.
      const abort = new AbortController();
      await listWorkspaceNames("t", ["brain-1"], abort.signal);
      expect(calls.at(-1)?.signal).toBe(abort.signal);
    } finally {
      globalThis.fetch = original;
    }

    const refused = await drive({
      nameBrains: async () => {
        throw new Error("no");
      },
    });
    // The session ran regardless, and its line simply names no brain.
    expect(refused.rows).toHaveLength(1);
    expect(refused.out.join("\n")).toContain("start");
    expect(refused.code).toBe(0);
  });
});

describe("run: where the connection keys are said to be", () => {
  it("121-S20: `run` says nothing when the keychain holds them, and says it with its reason when a file does", async () => {
    const quiet = await drive();
    // `drive`'s default store is a keychain, which is what a person already
    // assumes: the line was not news, and it cost a line of the block on every
    // start.
    expect(quiet.out.join("\n")).not.toContain("Connection keys are held");

    const fallback = await drive({
      openKeyStore: async () => ({
        backend: { kind: "file", where: "/state/secrets.json", reason: "this runtime has no keychain to put it in" },
        get: async () => "smd_agent_deadbeef_secret",
        set: async () => {},
        forget: async () => {},
      }),
    });
    const said = fallback.out.join("\n");
    // The one surface in the program that tells a person their connection keys
    // are in a plaintext file rather than the keychain they assumed.
    expect(said).toContain("Connection keys are held in /state/secrets.json");
    expect(said).toContain("this runtime has no keychain to put it in");
  });
});


describe("run: the countdown a signal restarts", () => {
  // The behaviour holds by construction — `run` says a deadline only at the line
  // it is about to sleep on, and a signal-driven tick comes back round to that
  // same line with the flag cleared — but nothing pinned it. A refactor of the
  // `if (!pollAsked)` guard could restore exactly the defect this case names
  // with every other signal test still green.
  it("121-S6: a signal that ends a wait leaves the next deadline a whole interval from the tick it caused", async () => {
    // The real sleeper, so the wake the signal's read reaches is the one `run`
    // is waiting on; a stubbed sleep registers no wake and the causal chain
    // under test would not exist.
    const { waitFor } = await import("../src/commands/run.ts");
    let at = new Date(2026, 8, 4, 12, 0, 0).getTime();
    let fire: ((dueInMs: number) => void) | null = null;
    let waits = 0;
    const ticks: number[] = [];

    const result = await drive(
      {
        isTTY: true,
        now: () => new Date(at),
        openSignals: (options) => {
          fire = options.onSignal;
          return { refresh: () => {}, close: () => {} };
        },
        count: async () => {
          ticks.push(at);
          return { waiting: 0, capped: false };
        },
        sleep: (ms, signal) => {
          const waiting = waitFor(ms, signal);
          waits += 1;
          if (waits === 1) {
            // Twenty minutes into the interval, work lands and is signalled.
            at += 20 * 60_000;
            fire!(0);
          } else {
            // The second wait is not what is being measured; end the run.
            captured.handler?.("quit");
          }
          return waiting;
        },
      },
      { once: false },
    );

    expect(result.code).toBe(0);
    // Two ticks: the one at start, and the one the signal caused.
    expect(ticks).toHaveLength(2);
    expect(ticks[1] - ticks[0]).toBe(20 * 60_000);

    const said = captured.events
      .filter((e): e is Extract<RunEvent, { kind: "phase" }> => e.kind === "phase")
      .map((e) => (e.phase.kind === "waiting" ? e.phase.at : null))
      .filter((deadline): deadline is number => deadline !== null);

    // One deadline before each wait, and each is a whole interval from the tick
    // that had just happened.
    expect(said).toHaveLength(2);
    expect(said[0]).toBe(ticks[0] + POLL_MS);
    expect(said[1]).toBe(ticks[1] + POLL_MS);
    // Which is the whole of it: a loop that inherited the remainder of the wait
    // nobody sat out would have said the same moment twice, and the countdown
    // would run down to a poll that had already happened.
    expect(said[1]).toBe(said[0] + 20 * 60_000);
    expect(said[1]).not.toBe(said[0]);
  }, 30_000);
});

describe("run: the read a session's end asks for", () => {
  // The real sleeper, so the wake the armed read reaches is the one `run` is
  // sitting on. Each of these ends the run from its second wait, so a version
  // that takes no read never reaches one and the case reds as a timeout.
  const driveFreed = async (over: Partial<import("../src/commands/run.ts").RunDeps> = {}, flags: Record<string, unknown> = {}) => {
    const { waitFor } = await import("../src/commands/run.ts");
    let waits = 0;
    const counts: number[] = [];
    const claims: number[] = [];
    const driven = await drive(
      {
        isTTY: true,
        count: async () => {
          counts.push(Date.now());
          return { waiting: counts.length === 1 ? 1 : 0, capped: false };
        },
        claim: async () => {
          claims.push(Date.now());
          return claims.length === 1 ? { work: [unit()], refused: [] } : { work: [], refused: [] };
        },
        sleep: (ms, signal) => {
          waits += 1;
          const waiting = waitFor(ms, signal);
          // The first wait is the one the session's end has to cut short; from
          // the second there is nothing left to measure, so end the run.
          if (waits >= 2) captured.handler?.("quit");
          return waiting;
        },
        ...over,
      },
      { once: false, ...flags },
    );
    return { driven, counts, claims };
  };

  it("117-S33: an agent whose session ends with nothing queued causes a read, which no trigger could have announced", async () => {
    const started = Date.now();
    const { driven, counts } = await driveFreed();
    expect(driven.code).toBe(0);
    // Two ticks: the one that found the unit, and the one the session's end
    // asked for. Without it the second would be a poll interval away — which is
    // three quarters of an hour, and is exactly how a unit that came due while
    // its agent was busy used to sit unclaimed.
    expect(counts).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(15_000);
    // Through the signal window rather than beside it, so the read lands a
    // debounce after the session rather than instantly.
    expect(counts[1] - counts[0]).toBeGreaterThanOrEqual(SIGNAL_DEBOUNCE_MS - 500);
  }, 30_000);

  it("117-S34: a queue draining unit by unit costs one read for the whole queue, not one per unit", async () => {
    // Two units for one agent: the first runs, the second waits behind it, and
    // the agent is only free when the second finishes. A read after each would
    // be a request for an agent that is still busy.
    //
    // What this holds is the COST, not the call. The `return` after the
    // recursive `startUnit` is what makes the announcement happen once, and
    // removing it leaves this green — the debounce and `SIGNAL_MIN_GAP_MS` fold
    // the extra call into the read this case was already counting. The guard is
    // still right and is covered by those two rather than by anything here.
    let claimed = 0;
    const { driven, counts } = await driveFreed({
      claim: async () => {
        claimed += 1;
        return claimed === 1
          ? { work: [unit("dev-bot-mdden", "c1", 1), unit("dev-bot-mdden", "c2", 2)], refused: [] }
          : { work: [], refused: [] };
      },
    });
    expect(driven.code).toBe(0);
    expect(driven.rows).toHaveLength(2);
    expect(counts).toHaveLength(2);
  }, 30_000);

  it("117-S35: `--once` counts exactly once, however many sessions end under it", async () => {
    // It runs exactly one tick by definition and is waiting out the sessions that
    // tick started. A read here would make `--once` ask twice.
    //
    // Same distinction as the case above: the explicit `once` guard in
    // `onAgentFreed` is not what this proves. Removing it leaves this green,
    // because by the time a session ends under `--once` the loop is already in
    // its finishing wait and an armed read never becomes a tick. The guard says
    // the intent at the place a reader looks for it; the count is the property.
    let counts = 0;
    const driven = await drive({
      count: async () => {
        counts += 1;
        return { waiting: 1, capped: false };
      },
    });
    expect(driven.code).toBe(0);
    expect(driven.rows).toHaveLength(1);
    expect(counts).toBe(1);
  }, 20_000);
});

describe("run: how long a unit waited before it was started", () => {
  it("121-S22: a unit that sat says so on the working line, and one claimed as it was written says nothing", () => {
    const at = new Date(2026, 8, 4, 12, 4, 1);
    const start = (recordedAt: Date): RunEvent => ({
      kind: "start",
      agent: "dev-bot-mdden",
      claim: "c1",
      unitKind: "file-changed",
      seq: 236,
      workspace: "96c4b572-7b22-44ea-8596-84b05e46d5c5",
      file: "04-specs/117-a-socket-the-runner-holds.md",
      brain: "markdown brain",
      recordedAt: recordedAt.toISOString(),
    });
    const noteFor = (recordedAt: Date) =>
      applyEvent(applyEvent(emptyView, { kind: "configured", agent: "dev-bot-mdden" }, at), start(recordedAt), at).agents[0].note;

    // The incident this exists for: an event written at 18:11:45Z whose session
    // began at 18:47:47Z, drawn until now exactly like one written a second ago.
    expect(noteFor(new Date(at.getTime() - 36 * 60_000))).toBe(
      "file-changed #236 · 04-specs/117-a-socket-the-runner-holds.md · markdown brain · waited 36m",
    );
    // And a fresh one says nothing, so the clause is a signal rather than
    // furniture on every line.
    expect(noteFor(at)).toBe("file-changed #236 · 04-specs/117-a-socket-the-runner-holds.md · markdown brain");
  });

  it("121-S22: the moment the event carries is the unit's own, not the moment it was claimed", async () => {
    // The two cases either side of this one build a `start` by hand, so they
    // pin what the reducer does with the field and nothing about where it comes
    // from. This drives the command: the whole of the feature is that the stamp
    // is the unit's envelope moment rather than a clock read at claim time, and
    // reading a clock here would make every wait zero and every line silent.
    const driven = await drive({ isTTY: true });
    expect(driven.code).toBe(0);
    const started = captured.events.filter((e): e is Extract<RunEvent, { kind: "start" }> => e.kind === "start");
    expect(started).toHaveLength(1);
    expect(started[0].recordedAt).toBe(unit().at);
  });

  it("121-S23: the wait is a finished fact at the moment the session starts, and does not tick", () => {
    // Computed from the event's own stamp, so this reducer stays clockless and
    // the rule that only three things on screen move without an event holds.
    const source = readFileSync(fileURLToPath(new URL("../src/run/view.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/setInterval|setTimeout|Date\.now/);

    // Under a minute is silence: a `file-changed` unit cannot be claimed until
    // its file has been quiet for a session window, so seconds would be noise on
    // every line.
    expect(waitedText(0)).toBeNull();
    expect(waitedText(59_999)).toBeNull();
    expect(waitedText(60_000)).toBe("waited 1m");
    expect(waitedText(36 * 60_000)).toBe("waited 36m");
    expect(waitedText(59 * 60_000 + 59_000)).toBe("waited 59m");
    expect(waitedText(3 * 3_600_000)).toBe("waited 3h");
    expect(waitedText(25 * 3_600_000)).toBe("waited 1d");
    // Clocks that disagree, and a stamp that is not one: neither invents a wait.
    expect(waitedText(-5_000)).toBeNull();
    expect(waitedText(Number.NaN)).toBeNull();
  });
});

describe("run: the connection key is read once for the run, not once for the unit", () => {
  // A store whose reads are counted and whose answer can change between them, so
  // a case can say both how many times it was asked and which value a session
  // was handed. The last value stands for every read past the list.
  const countingStore = (...values: (string | null)[]) => {
    const gets: string[] = [];
    return {
      gets,
      openKeyStore: async () => ({
        backend: { kind: "keychain" as const, where: "the keychain" },
        get: async (agentId: string) => {
          const value = values[Math.min(gets.length, values.length - 1)];
          gets.push(agentId);
          return value;
        },
        set: async () => {},
        forget: async () => {},
      }),
    };
  };

  /** A session that reached the workspace server the key opens and was not let in. */
  const refusedTheWorkspace = () =>
    good({ is_error: true, result: "no", permission_denials: [{ tool_name: "mcp__markdownbrain__read_file" }] });

  /** The key each session was actually handed, read off the child's environment. */
  const handed = (spawned: Array<{ env: Record<string, string> }>) =>
    spawned.map((s) => s.env.MDBRAIN_KEY_DEV_BOT_MDDEN);

  it("two units for one agent cost one read of the key store, not one each", async () => {
    // The property the whole change exists to create. On macOS a read is what
    // raises the password dialog, so a read per unit is a dialog per unit —
    // hours after the person who could answer it went away.
    const store = countingStore("smd_agent_deadbeef_secret");
    const driven = await drive({
      openKeyStore: store.openKeyStore,
      claim: async () => ({ work: [unit("dev-bot-mdden", "c1", 1), unit("dev-bot-mdden", "c2", 2)], refused: [] }),
    });
    expect(driven.code).toBe(0);
    expect(driven.rows).toHaveLength(2);
    expect(store.gets).toEqual(["agent-1"]);
  }, 20_000);

  it("a failed session reads once more, and every unit behind it uses what that read returned", async () => {
    // The staleness the held value costs: `configure --new-keys` against a live
    // run used to be picked up by the next session, because the next session
    // re-read. A failure is the one signal the run gets that its key may be the
    // wrong one, so it drops what it holds and reads again — once.
    const store = countingStore("first-key", "second-key", "third-key");
    const sessions: Array<{ env: Record<string, string> }> = [];
    const driven = await drive({
      openKeyStore: store.openKeyStore,
      claim: async () => ({
        work: [unit("dev-bot-mdden", "c1", 1), unit("dev-bot-mdden", "c2", 2), unit("dev-bot-mdden", "c3", 3)],
        refused: [],
      }),
      startSession: async (request) => {
        sessions.push(request.spawnable);
        return {
          stdout: sessions.length === 1 ? refusedTheWorkspace() : good(),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          stoppedBy: null,
          windows: false,
          signal: null,
          spawnProblem: null,
        };
      },
    });
    expect(driven.rows).toHaveLength(3);
    expect(store.gets).toHaveLength(2);
    // The third unit rides on the re-read rather than asking for one of its own.
    expect(handed(sessions)).toEqual(["first-key", "second-key", "second-key"]);
  }, 20_000);

  it("the re-read happens at most once per agent, so a run of failures is not a dialog per failure", async () => {
    // Without the bound the remedy becomes the problem: a machine whose sessions
    // fail for some reason that has nothing to do with the key would be back to
    // one read — and so one dialog — per unit, which is the failure being fixed.
    const store = countingStore("k1", "k2", "k3", "k4");
    const sessions: Array<{ env: Record<string, string> }> = [];
    const driven = await drive({
      openKeyStore: store.openKeyStore,
      claim: async () => ({
        work: [unit("dev-bot-mdden", "c1", 1), unit("dev-bot-mdden", "c2", 2), unit("dev-bot-mdden", "c3", 3)],
        refused: [],
      }),
      startSession: async (request) => {
        sessions.push(request.spawnable);
        return {
          stdout: refusedTheWorkspace(),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          stoppedBy: null,
          windows: false,
          signal: null,
          spawnProblem: null,
        };
      },
    });
    expect(driven.code).toBe(1);
    expect(driven.rows).toHaveLength(3);
    expect(store.gets).toHaveLength(2);
    expect(handed(sessions)).toEqual(["k1", "k2", "k2"]);
  }, 20_000);

  it("a failure the key had no part in does not spend the one re-read", async () => {
    // There is one re-read for each agent in a run. A session that would not
    // spawn says nothing about the key, so burning it here would leave a key
    // renewed later in the same run unreachable for the rest of it — and would
    // raise the unattended dialog this whole change exists to stop.
    const store = countingStore("first-key", "second-key");
    const sessions: Array<{ env: Record<string, string> }> = [];
    const driven = await drive({
      openKeyStore: store.openKeyStore,
      claim: async () => ({ work: [unit("dev-bot-mdden", "c1", 1), unit("dev-bot-mdden", "c2", 2)], refused: [] }),
      startSession: async (request) => {
        sessions.push(request.spawnable);
        return {
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          stoppedBy: null,
          windows: false,
          signal: null,
          spawnProblem: sessions.length === 1 ? "the harness could not be started" : null,
        };
      },
    });
    expect(driven.rows[0]).toMatchObject({ outcome: "spawn-failed" });
    expect(store.gets).toHaveLength(1);
    expect(handed(sessions)).toEqual(["first-key", "first-key"]);
  }, 20_000);

  it("two agents failing at once read one at a time, so neither waits behind two dialogs", async () => {
    // Sessions for different agents run in parallel, so two of them reaching the
    // re-read together is ordinary. Concurrent keychain reads are two windows
    // stacked on each other with a session blocked behind each.
    let reading = 0;
    let most = 0;
    const gets: string[] = [];
    const driven = await drive({
      loadConfiguration: async () => ({
        kind: "config",
        config: config({ "dev-bot-mdden": entry(), "second-dev-bot-mdden": entry({ id: "agent-2" }) }),
      }),
      roster: async () => [
        { id: "agent-1", org_id: "o", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-1" },
        { id: "agent-2", org_id: "o", display_name: "second-dev-bot-mdden", status: "active", bot_user_id: "u-2" },
      ],
      claim: async () => ({ work: [unit("dev-bot-mdden", "c1", 1), unit("second-dev-bot-mdden", "c2", 2)], refused: [] }),
      openKeyStore: async () => ({
        backend: { kind: "keychain" as const, where: "the keychain" },
        get: async (agentId: string) => {
          reading += 1;
          most = Math.max(most, reading);
          await new Promise((resolve) => setTimeout(resolve, 5));
          reading -= 1;
          gets.push(agentId);
          return "smd_agent_deadbeef_secret";
        },
        set: async () => {},
        forget: async () => {},
      }),
      startSession: async () => ({
        stdout: refusedTheWorkspace(),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        stoppedBy: null,
        windows: false,
        signal: null,
        spawnProblem: null,
      }),
    });
    expect(driven.rows).toHaveLength(2);
    // Two agents read at startup and each re-reads once after its refusal.
    expect(gets).toHaveLength(4);
    expect(most).toBe(1);
  }, 20_000);

  it("a key that was not there when the run started is still found by the unit after the failure", async () => {
    // Holding a value must not turn a transient answer into a permanent one. A
    // key minted after the run began used to be picked up by the next session
    // for free; the re-read is what keeps that true.
    const store = countingStore(null, "smd_agent_deadbeef_secret");
    const driven = await drive({
      openKeyStore: store.openKeyStore,
      claim: async () => ({ work: [unit("dev-bot-mdden", "c1", 1), unit("dev-bot-mdden", "c2", 2)], refused: [] }),
    });
    expect(driven.rows).toHaveLength(2);
    expect(driven.rows[0]).toMatchObject({ outcome: "spawn-failed" });
    expect(driven.rows[1]).toMatchObject({ outcome: "done" });
    expect(store.gets).toHaveLength(2);
  }, 20_000);

  it("a read that throws at startup does not end the run: it is the unit's own outcome, as it always was", async () => {
    // The read moved; what a person sees when it fails did not. It is still one
    // failed unit naming the refusal, rather than a runner that would not start.
    const gets: string[] = [];
    const driven = await drive({
      openKeyStore: async () => ({
        backend: { kind: "keychain" as const, where: "the operating system's keychain" },
        get: async (agentId: string) => {
          gets.push(agentId);
          throw new Error("this machine's keychain will not let this copy of mdbrain read a key an earlier copy stored");
        },
        set: async () => {},
        forget: async () => {},
      }),
    });
    expect(driven.code).toBe(1);
    expect(driven.rows).toHaveLength(1);
    expect(driven.rows[0]).toMatchObject({ outcome: "spawn-failed" });
    expect(driven.out.join("\n")).toContain("will not let this copy of mdbrain read a key");
  }, 20_000);

  it("two configured names pointing at one agent cost one read between them", async () => {
    // `config.agents` is keyed by name and carries the id separately, nothing
    // refuses two names bearing one id, and `holdReason` gates on the name — so
    // both reach `asking` and the ids handed here repeat. A second read of one
    // item is a second dialog for it, which is the quantity this whole module
    // exists to reduce.
    const gets: string[] = [];
    const store = {
      backend: { kind: "keychain" as const, where: "the keychain" },
      get: async (agentId: string) => {
        gets.push(agentId);
        return "smd_agent_deadbeef_secret";
      },
      set: async () => {},
      forget: async () => {},
    };

    const keys = await holdConnectionKeys(store, ["agent-1", "agent-2", "agent-1"]);

    expect(gets).toEqual(["agent-1", "agent-2"]);
    expect(keys.held("agent-1")).toEqual({ kind: "key", key: "smd_agent_deadbeef_secret" });
  });
});

describe("run: the console window closing", () => {
  const stoppedEnding = (): import("../src/run/execute.ts").SessionEnding => ({
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    stoppedBy: "runner",
    windows: true,
    signal: "kill",
    spawnProblem: null,
  });

  it("105-S103: on Windows the window closing stops every running session the way Ctrl-C does, and leaves no handler behind", async () => {
    const before = process.listenerCount("SIGHUP");
    let askedToStop = false;
    const result = await drive({
      isWindows: true,
      startSession: async (request) =>
        new Promise((resolve) => {
          request.onStop?.(() => {
            askedToStop = true;
            resolve(stoppedEnding());
          });
          // The window closes while the session is running. On Windows Node
          // raises SIGHUP for that; emitting it is the same delivery without a
          // window to close. The session only ends once the stopper asks it to,
          // which is what makes the assertion below mean something.
          queueMicrotask(() => process.emit("SIGHUP", "SIGHUP"));
        }),
    });
    expect(askedToStop).toBe(true);
    expect(result.code).toBe(0);
    expect(result.rows.map((row) => (row as { outcome: string }).outcome)).toEqual(["stopped"]);
    // Removed with the other two when the run ends, so a later `run` in the same
    // process registers its own rather than stacking on this one.
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  it("105-S103: a window closing after a stop has begun leaves that stop to finish, where a second Ctrl-C would get out", async () => {
    // The escape re-raises SIGINT at this very process, which would end the
    // worker rather than fail the case; stubbed so the choice is observable.
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      let stopsAsked = 0;
      let killsAfterHangup = -1;
      let killsAfterSecondInterrupt = -1;
      const result = await drive({
        isWindows: true,
        startSession: async (request) =>
          new Promise((resolve) => {
            request.onStop?.(() => {
              stopsAsked += 1;
            });
            queueMicrotask(() => {
              process.emit("SIGINT", "SIGINT");
              process.emit("SIGHUP", "SIGHUP");
              killsAfterHangup = kill.mock.calls.length;
              process.emit("SIGINT", "SIGINT");
              killsAfterSecondInterrupt = kill.mock.calls.length;
              resolve(stoppedEnding());
            });
          }),
      });
      expect(result.code).toBe(0);
      expect(stopsAsked).toBe(1);
      expect(killsAfterHangup).toBe(0);
      expect(killsAfterSecondInterrupt).toBe(1);
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
    } finally {
      kill.mockRestore();
    }
  });

  it("105-S103: elsewhere no hangup handler is installed, so a terminal going away keeps Node's default", async () => {
    const before = process.listenerCount("SIGHUP");
    let during = -1;
    const result = await drive({
      isWindows: false,
      startSession: async () => {
        during = process.listenerCount("SIGHUP");
        return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null };
      },
    });
    expect(result.code).toBe(0);
    expect(during).toBe(before);
  });
});

describe("run: the MCP file is the binary's own", () => {
  const stale = JSON.stringify({ mcpServers: { "old-name": { type: "http", url: "https://mcp.example.invalid/mcp" } } });

  it("a file on disk naming another URL and another key is rewritten to this binary's values before the harness starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mdbrain-mcp-"));
    try {
      const at = { platform: process.platform, home: dir, env: { MDBRAIN_CONFIG_DIR: dir } };
      const path = mcpConfigPath("dev-bot-mdden", at);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, stale);
      // Read inside the spawn rather than after the run, because what matters is
      // what Claude Code finds when it starts, not what is left once it has gone.
      let found: string | null = null;
      let pointedAt: string | null = null;
      const ran = await drive({
        writeMcpFile: (agent, key, harness) => writeMcpConfig(agent, key, harness, at),
        startSession: async (request) => {
          const args = request.spawnable.args;
          pointedAt = args[args.indexOf("--mcp-config") + 1];
          found = readFileSync(pointedAt, "utf8");
          return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null };
        },
      });
      expect(ran.rows[0]).toMatchObject({ outcome: "done" });
      expect(pointedAt).toBe(path);
      expect(found).toBe(claudeHarness.mcpConfigText("MDBRAIN_KEY_DEV_BOT_MDDEN"));
      const servers = (JSON.parse(found!) as { mcpServers: Record<string, { url: string }> }).mcpServers;
      expect(Object.keys(servers)).toEqual([MCP_SERVER_NAME]);
      expect(servers[MCP_SERVER_NAME].url).toBe(MCP_URL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a file that cannot be written holds its agent before anything is claimed, rather than falling back to the one on disk", async () => {
    const claim = vi.fn(async () => ({ work: [unit()], refused: [] }));
    const startSession = vi.fn();
    const ran = await drive({
      writeMcpFile: async () => {
        throw new Error("EACCES: permission denied");
      },
      claim,
      startSession,
    });
    expect(claim).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(ran.out.join("\n")).toContain("its MCP file could not be written: EACCES");
    expect(ran.code).toBe(1);
  });

  it("the file is written once at startup, not again before each session", async () => {
    const writeMcpFile = vi.fn(async (agent: string) => mcpConfigPath(agent));
    await drive({ writeMcpFile, claim: async () => ({ work: [unit(), unit("dev-bot-mdden", "c2f0", 8413)], refused: [] }) });
    expect(writeMcpFile).toHaveBeenCalledTimes(1);
  });
});

describe("run: the in-flight record a session leaves while it runs", () => {
  type InFlightRecord = import("../src/run/inflight.ts").InFlightRecord;
  type RunDeps = import("../src/commands/run.ts").RunDeps;

  /** An in-memory store, with every write, removal and run-log row in order. */
  const store = () => {
    const records = new Map<string, InFlightRecord>();
    const log: string[] = [];
    const inFlight: RunDeps["inFlight"] = {
      write: async (record) => {
        records.set(record.claim, record);
        log.push(`write ${record.claim}`);
      },
      remove: async (claim) => {
        records.delete(claim);
        log.push(`remove ${claim}`);
      },
      list: async () => [...records.values()],
      lock: async () => null,
      nameHarness: async () => {},
      unlock: async () => {},
    };
    const recordRun: RunDeps["recordRun"] = async (row) => {
      log.push(`row ${row.claim}`);
    };
    return { records, log, inFlight, recordRun };
  };

  /** A session that spawns, and remembers which records existed while it ran. */
  const spawning = (records: Map<string, InFlightRecord>, during: InFlightRecord[][], over: Record<string, unknown> = {}): RunDeps["startSession"] =>
    async (request) => {
      request.onSpawned?.(5150);
      // One turn for the write the spawn started.
      await new Promise((resolve) => setTimeout(resolve, 0));
      during.push([...records.values()]);
      return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null, ...over };
    };

  it("163-S1: the record exists while the session runs, names the entry and both pids, and after the row goes only for an outcome that cannot be resumed", async () => {
    for (const over of [{}, { stdout: "", stderr: "boom", exitCode: 1 }]) {
      const { records, log, inFlight, recordRun } = store();
      const during: InFlightRecord[][] = [];
      await drive({ inFlight, recordRun, startSession: spawning(records, during, over) });

      expect(during).toHaveLength(1);
      expect(during[0]).toEqual([
        expect.objectContaining({
          claim: "c1f0",
          agentEntryId: "agent-1",
          agent: "dev-bot-mdden",
          workspace: "01-ideas",
          cwd,
          ownerPid: 4410,
          harnessPid: 5150,
          resumes: 0,
        }),
      ]);
      // The ending is in the run log before the record says how it ended.
      if ("exitCode" in over) {
        expect(log).toEqual(["write c1f0", "row c1f0", "write c1f0"]);
        expect(records.get("c1f0")).toEqual(expect.objectContaining({ ownerPid: null, harnessPid: null, ended: "failed" }));
      } else {
        expect(log).toEqual(["write c1f0", "row c1f0", "remove c1f0"]);
        expect(records.size).toBe(0);
      }
    }
  });

  it("163-S2: a session that never spawned writes no record", async () => {
    const { log, inFlight, recordRun } = store();
    await drive({
      inFlight,
      recordRun,
      startSession: async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: "spawn claude ENOENT" }),
    });
    expect(log).toEqual(["row c1f0"]);
  });

  it("163-S4: a record that cannot be written is one note, and the session ends exactly as it would have", async () => {
    const { records, log, recordRun } = store();
    const during: InFlightRecord[][] = [];
    const rows: unknown[] = [];
    const driven = await drive({
      inFlight: {
        write: async () => {
          throw new Error("EACCES: permission denied");
        },
        remove: async (claim) => {
          log.push(`remove ${claim}`);
        },
        list: async () => [],
        lock: async () => null,
        nameHarness: async () => {},
        unlock: async () => {},
      },
      recordRun: async (row) => {
        rows.push(row);
        await recordRun(row);
      },
      startSession: spawning(records, during),
    });
    expect(driven.code).toBe(0);
    expect(rows).toEqual([expect.objectContaining({ claim: "c1f0", outcome: "done" })]);
    const notes = driven.out.filter((line) => line.includes("in-flight record could not be written"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("EACCES");
    // Nothing was written, so nothing is removed.
    expect(log).toEqual(["row c1f0"]);
  });

  it("163-S21: a runner that finds records a crash left says where to pick them up, and starts nothing for them", async () => {
    const left: InFlightRecord = {
      claim: "77e00000-0000-4000-8000-000000000000",
      agentEntryId: "agent-1",
      agent: "dev-bot-mdden",
      workspace: "01-ideas",
      brain: "markdown brain",
      cwd,
      startedAt: "2026-09-04T09:00:00.000Z",
      ownerPid: 999,
      harnessPid: null,
      resumes: 0,
      ended: null,
      endedAt: null,
    };
    const crashed = await drive({
      inFlight: { write: async () => {}, remove: async () => {}, list: async () => [left], lock: async () => null, nameHarness: async () => {}, unlock: async () => {} },
      count: async () => ({ waiting: 0, capped: false }),
    });
    expect(crashed.spawned).toEqual([]);
    const said = crashed.out.filter((line) => line.includes("mdbrain resume"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("dev-bot-mdden");
    expect(said[0]).toContain("77e0");

    // A record whose session is still running elsewhere is not left behind.
    const elsewhere = await drive({
      inFlight: { write: async () => {}, remove: async () => {}, list: async () => [left], lock: async () => null, nameHarness: async () => {}, unlock: async () => {} },
      isAlive: (pid) => pid === 999,
      count: async () => ({ waiting: 0, capped: false }),
    });
    expect(elsewhere.out.join("\n")).not.toContain("mdbrain resume");
  });
});

describe("run: r on a failed run", () => {
  const feed = (events: RunEvent[]) => events.reduce((state, event) => applyEvent(state, event, AT), emptyView);
  const press = (over: Partial<KeyModifiers> = {}): KeyModifiers => ({ ctrl: false, upArrow: false, downArrow: false, escape: false, ...over });
  const recent = (outcome: OutcomeKind) => ({
    kind: "recent" as const,
    run: feed([
      { kind: "configured", agent: "a" },
      outcome === "done"
        ? { kind: "done", agent: "a", claim: "c9", ms: 1000, costUsd: 0.1, turns: 1, message: "Finished." }
        : { kind: "failed", agent: "a", claim: "c9", outcome, ms: 1000, message: "It went wrong." },
    ]).recent[0],
  });

  it("163-S18: r is offered and taken only for a run whose harness ran and was cut short, a stop included", () => {
    for (const outcome of ["stopped", "failed", "timed-out", "killed", "unreadable"] as const) {
      const run = recent(outcome);
      expect(actionForKey("r", press(), run)).toEqual({ to: "resume" });
      expect(keyHints(run)).toContain("r — resume this run");
    }
    for (const outcome of ["done", "spawn-failed"] as const) {
      const run = recent(outcome);
      expect(actionForKey("r", press(), run)).toBeNull();
      expect(keyHints(run).join(" ")).not.toContain("resume");
    }
    // With nothing open there is nothing to resume.
    expect(actionForKey("r", press(), null)).toBeNull();
    expect(keyHints().join(" ")).not.toContain("resume");
  });

  it("163-S18: on the real screen, r on the open failed run asks the loop for exactly that run, and r on a done one asks nothing", async () => {
    const DOWN = "\u001b[B";
    const settle = async () => {
      for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
    };
    const asked: ViewRequest[] = [];
    const view = feed([
      { kind: "configured", agent: "a" },
      { kind: "done", agent: "a", claim: "c1", ms: 1000, costUsd: 0.1, turns: 1, message: "Triaged three files." },
      { kind: "failed", agent: "a", claim: "c2", outcome: "timed-out", ms: 2000, message: "the wall clock ran out" },
    ]);
    const { lastFrame, stdin } = render(liveScreenFor(view, (request) => asked.push(request)));
    await settle();
    stdin.write("r");
    await settle();
    expect(asked).toEqual([]);
    stdin.write(DOWN);
    await settle();
    expect(lastFrame() ?? "").toContain("r — resume this run");
    stdin.write("r");
    await settle();
    expect(asked).toEqual([{ kind: "resume", agent: "a", claim: "c2" }]);
    stdin.write(DOWN);
    await settle();
    expect(lastFrame() ?? "").not.toContain("resume this run");
    stdin.write("r");
    await settle();
    expect(asked).toHaveLength(1);
  });

  it("163-S19/S20: the view gives the terminal up while the loop goes on, an interrupt then is the person's, and Ctrl-C stops the runner again after", async () => {
    const { waitFor } = await import("../src/commands/run.ts");
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5));
      expect(done()).toBe(true);
    };
    const polls = () => captured.events.filter((e) => e.kind === "poll").length;
    const order: string[] = [];
    let claimed = false;
    let waits = 0;
    // Once the view is back, Ctrl-C is the runner's again, and it is what ends this run.
    captured.onResume = () => setTimeout(() => process.emit("SIGINT", "SIGINT"), 10);

    const driven = await drive(
      {
        isTTY: true,
        count: async () => ({ waiting: claimed ? 0 : 1, capped: false }),
        claim: async () => {
          claimed = true;
          return { work: [unit()], refused: [] };
        },
        // The unit fails, which is what makes it resumable from the view.
        startSession: async () => ({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null }),
        prepareResume: async (target) => {
          order.push(`prepare ${target.agent} ${target.claim} ${target.workspace} ${target.cwd}`);
          return {
            cancel: async () => {
              order.push("cancel");
            },
            start: async () => {
              order.push(`start, view ${captured.terminal.at(-1)}`);
              // S20: the person presses Ctrl-C inside their session.
              process.emit("SIGINT", "SIGINT");
              // S19: the loop is still going, and its events still arrive.
              const before = polls();
              captured.handler?.("poll-now");
              await until(() => polls() > before);
              order.push("polled while resumed");
              return 0;
            },
          };
        },
        sleep: (ms, signal) => {
          const waiting = waitFor(ms, signal);
          waits += 1;
          // Asked after the failed session has ended, as a person would.
          if (waits === 1) setTimeout(() => captured.handler?.({ kind: "resume", agent: "dev-bot-mdden", claim: "c1f0" }), 20);
          return waiting;
        },
      },
      { once: false },
    );
    void driven;
    // Unreachable unless the runner stopped: the stop below is what ends it.
    expect(order).toEqual([`prepare dev-bot-mdden c1f0 01-ideas ${cwd}`, "start, view suspend", "polled while resumed"]);
    expect(captured.terminal).toEqual(["suspend", "resume"]);
    const kinds = captured.events.map((e) => (e.kind === "phase" ? `phase:${e.phase.kind}` : e.kind));
    // The interrupt during the session did not stop the runner: the poll after
    // it happened, and finishing came only with the Ctrl-C after the remount.
    expect(kinds.lastIndexOf("poll")).toBeLessThan(kinds.indexOf("phase:finishing"));
    expect(captured.events).toContainEqual({ kind: "note", message: "dev-bot-mdden's resumed session ended." });
  });

  // A resumed session's harness inherits this process's terminal. A runner that
  // finished without it would print its last line over the person's session and
  // drop the interrupt guard under them.
  it("163-S24: a SIGTERM while a resumed session has the terminal ends the runner after that session, never from under it", async () => {
    const { waitFor } = await import("../src/commands/run.ts");
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5));
      expect(done()).toBe(true);
    };
    const order: string[] = [];
    let claimed = false;
    let waits = 0;

    await drive(
      {
        isTTY: true,
        count: async () => ({ waiting: claimed ? 0 : 1, capped: false }),
        claim: async () => {
          claimed = true;
          return { work: [unit()], refused: [] };
        },
        startSession: async () => ({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null }),
        prepareResume: async () => ({
          cancel: async () => {
            order.push("cancel");
          },
          start: async () => {
            process.emit("SIGTERM", "SIGTERM");
            await until(() => captured.events.some((e) => e.kind === "phase" && e.phase.kind === "finishing"));
            // Long enough for a runner that did not wait to have reached its last line.
            await new Promise((r) => setTimeout(r, 50));
            order.push(`session ends; runner already stopped: ${captured.events.some((e) => e.kind === "stopped")}`);
            return 0;
          },
        }),
        sleep: (ms, signal) => {
          const waiting = waitFor(ms, signal);
          waits += 1;
          if (waits === 1) setTimeout(() => captured.handler?.({ kind: "resume", agent: "dev-bot-mdden", claim: "c1f0" }), 20);
          return waiting;
        },
      },
      { once: false },
    );

    expect(order).toEqual(["session ends; runner already stopped: false"]);
    expect(captured.events.at(-1)?.kind).toBe("stopped");
  });

  it("163-S25: a runner that begins stopping while a resume is being checked cancels it, and never gives the terminal up", async () => {
    const { waitFor } = await import("../src/commands/run.ts");
    const order: string[] = [];
    let claimed = false;
    let waits = 0;

    await drive(
      {
        isTTY: true,
        count: async () => ({ waiting: claimed ? 0 : 1, capped: false }),
        claim: async () => {
          claimed = true;
          return { work: [unit()], refused: [] };
        },
        startSession: async () => ({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null }),
        prepareResume: async () => {
          // The stop lands while the checks are still running.
          process.emit("SIGTERM", "SIGTERM");
          return {
            cancel: async () => {
              order.push("cancel");
            },
            start: async () => {
              order.push("start");
              return 0;
            },
          };
        },
        sleep: (ms, signal) => {
          const waiting = waitFor(ms, signal);
          waits += 1;
          if (waits === 1) setTimeout(() => captured.handler?.({ kind: "resume", agent: "dev-bot-mdden", claim: "c1f0" }), 20);
          return waiting;
        },
      },
      { once: false },
    );

    expect(order).toEqual(["cancel"]);
    expect(captured.terminal).toEqual([]);
  });
});

describe("run: killing one running session", () => {
  type RunDeps = import("../src/commands/run.ts").RunDeps;
  type SessionEnding = import("../src/run/execute.ts").SessionEnding;
  type StopReason = import("../src/run/execute.ts").StopReason;

  const A = "3f2a0000-0000-4000-8000-00000000000a";
  const B = "77e00000-0000-4000-8000-00000000000b";
  const NOW = new Date(2026, 8, 4, 12, 4, 1).getTime();
  const DOWN = "\u001b[B";
  const ESC = "\u001b";
  const feed = (events: RunEvent[], at: Date = AT) => events.reduce((state, event) => applyEvent(state, event, at), emptyView);
  const press = (over: Partial<KeyModifiers> = {}): KeyModifiers => ({ ctrl: false, upArrow: false, downArrow: false, escape: false, ...over });
  const start = (agent: string, claim: string): RunEvent => ({
    kind: "start",
    agent,
    claim,
    unitKind: "file-arrived",
    seq: 8412,
    workspace: "01-ideas",
    file: "01-ideas/37-a-doctor-command.md",
    brain: "markdown brain",
    recordedAt: AT.toISOString(),
  });
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 400 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(done()).toBe(true);
  };
  const two = {
    loadConfiguration: async () => ({
      kind: "config" as const,
      config: config({ "dev-bot-mdden": entry(), "spec-warden": entry({ id: "agent-2" }) }),
    }),
    roster: async () => [
      { id: "agent-1", org_id: "o", display_name: "dev-bot-mdden", status: "active", bot_user_id: "u-agent-1" },
      { id: "agent-2", org_id: "o", display_name: "spec-warden", status: "active", bot_user_id: "u-agent-2" },
    ],
  };

  /**
   * Sessions that run until they are stopped or finished by hand. A stopper ends
   * its session a moment later rather than at once, as a real grace does, so a
   * request can land while a session is ending.
   */
  const stoppable = () => {
    const live = new Map<string, { reasons: StopReason[]; finish: () => void }>();
    const startSession: RunDeps["startSession"] = (request) =>
      new Promise<SessionEnding>((resolve) => {
        const args = request.spawnable.args;
        const claim = args[args.indexOf("--session-id") + 1];
        const reasons: StopReason[] = [];
        const ended = (over: Partial<SessionEnding>) =>
          resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null, ...over });
        request.onStop?.((reason) => {
          reasons.push(reason);
          if (reasons.length > 1) return;
          setTimeout(() => ended({ stoppedBy: reason === "kill" ? "person" : "runner", signal: "term" }), 10);
        });
        live.set(claim, { reasons, finish: () => ended({ stdout: good(), exitCode: 0 }) });
      });
    return { live, startSession };
  };
  const notes = () => captured.events.flatMap((e) => (e.kind === "note" ? [e.message] : []));
  const ended = (claim: string) => captured.events.find((e) => (e.kind === "failed" || e.kind === "done") && e.claim === claim);

  it("167-S1: a kill reaches only the stopper kept under its claim, with `kill`, and the other session keeps running", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ ...two, isTTY: true, claim: async () => ({ work: [unit("dev-bot-mdden", A), unit("spec-warden", B)], refused: [] }), startSession });
    await until(() => live.size === 2);
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: A });
    expect(live.get(A)!.reasons).toEqual(["kill"]);
    expect(live.get(B)!.reasons).toEqual([]);
    await until(() => ended(A) !== undefined);
    expect(ended(B)).toBeUndefined();
    live.get(B)!.finish();
    const driven = await running;
    expect(driven.rows.map((row) => [(row as { claim: string }).claim, (row as { outcome: string }).outcome])).toEqual([
      [A, "killed"],
      [B, "done"],
    ]);
  });

  it("167-S2: stopping the runner fires every stopper with `stop`, and both sessions end as `stopped`", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ ...two, isTTY: true, claim: async () => ({ work: [unit("dev-bot-mdden", A), unit("spec-warden", B)], refused: [] }), startSession });
    await until(() => live.size === 2);
    process.emit("SIGTERM", "SIGTERM");
    const driven = await running;
    expect(live.get(A)!.reasons).toEqual(["stop"]);
    expect(live.get(B)!.reasons).toEqual(["stop"]);
    expect(driven.rows.map((row) => (row as { outcome: string }).outcome)).toEqual(["stopped", "stopped"]);
  });

  it("167-S3: a running row carries the claim its start named, and gives it up when the session ends either way", () => {
    const running = feed([{ kind: "configured", agent: "a" }, start("a", A)]);
    expect(running.agents[0]).toMatchObject({ state: "running", claim: A, startedAt: AT });
    const failed = applyEvent(running, { kind: "failed", agent: "a", claim: A, outcome: "killed", ms: 1000, message: "You killed it." }, AT);
    expect(failed.agents[0]).toMatchObject({ claim: null, startedAt: null });
    const done = applyEvent(running, { kind: "done", agent: "a", claim: A, ms: 1000, costUsd: 0.1, turns: 1, message: "Done." }, AT);
    expect(done.agents[0]).toMatchObject({ claim: null, startedAt: null });
  });

  it("167-S4: the cursor walks the running session first, then the recent runs", () => {
    const view = feed([
      { kind: "configured", agent: "a" },
      { kind: "configured", agent: "b" },
      { kind: "done", agent: "b", claim: "c1", ms: 1000, costUsd: 0.1, turns: 1, message: "Done." },
      { kind: "failed", agent: "b", claim: "c2", outcome: "failed", ms: 1000, message: "No." },
      start("a", A),
    ]);
    expect(cursorClaims(view)).toEqual([A, "c2", "c1"]);
    const first = moveSelection(view, null, "older");
    expect(first).toBe(A);
    expect(pickedSession(view, first)).toMatchObject({ kind: "running", row: { agent: "a", claim: A } });
    const second = moveSelection(view, first, "older");
    expect(second).toBe("c2");
    expect(moveSelection(view, second, "older")).toBe("c1");
    expect(moveSelection(view, first, "newer")).toBeNull();
  });

  it("167-S5: the cursor stays on a session that ends, now on its run; k goes, and r comes if the outcome is resumable", () => {
    const view = feed([{ kind: "configured", agent: "a" }, start("a", A)]);
    const selection = moveSelection(view, null, "older");
    expect(actionForKey("k", press(), pickedSession(view, selection))).toEqual({ to: "kill" });

    const killed = applyEvent(view, { kind: "failed", agent: "a", claim: A, outcome: "killed", ms: 1000, message: "You killed it." }, AT);
    const after = pickedSession(killed, selection);
    expect(after).toMatchObject({ kind: "recent", run: { claim: A, outcome: "killed" } });
    expect(actionForKey("k", press(), after)).toBeNull();
    expect(actionForKey("r", press(), after)).toEqual({ to: "resume" });

    const finished = applyEvent(view, { kind: "done", agent: "a", claim: A, ms: 1000, costUsd: 0.1, turns: 1, message: "Done." }, AT);
    const done = pickedSession(finished, selection);
    expect(done).toMatchObject({ kind: "recent", run: { claim: A, outcome: "done" } });
    expect(actionForKey("r", press(), done)).toBeNull();
  });

  it("167-S6: k is neither drawn nor matched unless a running session that is not ending is picked", () => {
    const view = feed([
      { kind: "configured", agent: "a" },
      { kind: "failed", agent: "a", claim: "c1", outcome: "failed", ms: 1000, message: "No." },
      start("a", A),
    ]);
    for (const picked of [null, pickedSession(view, "c1")]) {
      expect(actionForKey("k", press(), picked)).toBeNull();
      expect(keyHints(picked).join(" ")).not.toContain("kill");
    }
    const running = pickedSession(view, A);
    expect(keyHints(running)).toContain("k — kill this session");
    const ending = pickedSession(view, A, new Set([A]));
    expect(actionForKey("k", press(), ending)).toBeNull();
    expect(keyHints(ending).join(" ")).not.toContain("kill");
    expect(render(liveView(view, { now: NOW, keysActive: true, selection: null })).lastFrame()).not.toContain("kill this session");
  });

  it("167-S7: only y confirms; n, esc, k and p each close the question, send nothing, and esc leaves the cursor where it was", async () => {
    const asked: ViewRequest[] = [];
    const view = feed([{ kind: "configured", agent: "a" }, start("a", A)]);
    const { lastFrame, stdin } = render(liveScreenFor(view, (request) => asked.push(request)));
    await settle();
    stdin.write(DOWN);
    await settle();
    for (const answer of ["n", ESC, "k", "p"]) {
      stdin.write("k");
      await settle();
      expect(lastFrame() ?? "").toContain("y to kill, any other key to keep it.");
      stdin.write(answer);
      await settle();
      expect(asked).toEqual([]);
      expect(lastFrame() ?? "").not.toContain("y to kill");
      expect(lastFrame() ?? "").toContain("The session you picked");
    }
    // Ctrl-C keeps the session as well, and still stops the runner.
    stdin.write("k");
    await settle();
    stdin.write("\u0003");
    await settle();
    expect(asked).toEqual(["quit"]);
    asked.length = 0;
    stdin.write("k");
    await settle();
    stdin.write("y");
    await settle();
    expect(asked).toEqual([{ kind: "kill", agent: "a", claim: A }]);
    // The row reads as ending, and k is not offered for it a second time.
    expect(lastFrame() ?? "").toContain(ENDING_BY_YOU);
    expect(lastFrame() ?? "").not.toContain("kill this session");
  });

  it("167-S8: the question names the agent, the short claim and how long the session has run", async () => {
    const row = feed([{ kind: "configured", agent: "dev-bot-mdden" }, start("dev-bot-mdden", A)]).agents[0];
    expect(killQuestion(row, AT.getTime() + 252_000)).toBe(
      "Kill dev-bot-mdden's session (claim 3f2a…, running 4m12s)? y to kill, any other key to keep it.",
    );

    const view = feed([{ kind: "configured", agent: "dev-bot-mdden" }, start("dev-bot-mdden", A)], new Date(Date.now() - 252_000));
    const { lastFrame, stdin } = render(liveScreenFor(view));
    await settle();
    stdin.write(DOWN);
    await settle();
    stdin.write("k");
    await settle();
    expect(lastFrame() ?? "").toMatch(/Kill dev-bot-mdden's session \(claim 3f2a…, running 4m1[23]s\)\?/);
  });

  it("167-S9: a question whose session ends first closes itself, says so, and a y afterwards sends nothing", async () => {
    const asked: ViewRequest[] = [];
    const view = feed([{ kind: "configured", agent: "a" }, start("a", A)]);
    const { lastFrame, stdin, rerender } = render(liveScreenFor(view, (request) => asked.push(request)));
    await settle();
    stdin.write(DOWN);
    await settle();
    stdin.write("k");
    await settle();
    expect(lastFrame() ?? "").toContain("Kill a's session");
    const over = applyEvent(view, { kind: "done", agent: "a", claim: A, ms: 1000, costUsd: 0.1, turns: 1, message: "Done." }, AT);
    rerender(liveScreenFor(over, (request) => asked.push(request)));
    await settle();
    expect(lastFrame() ?? "").not.toContain("Kill a's session");
    expect(lastFrame() ?? "").toContain(KILL_OUTRUN);
    stdin.write("y");
    await settle();
    expect(asked).toEqual([]);
  });

  it("167-S10: a kill for a claim with no stopper is refused out loud, and nothing fires", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ isTTY: true, claim: async () => ({ work: [unit("dev-bot-mdden", A)], refused: [] }), startSession });
    await until(() => live.size === 1);
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: B });
    expect(notes()).toContain("That session had already finished.");
    expect(live.get(A)!.reasons).toEqual([]);
    live.get(A)!.finish();
    await running;
  });

  it("167-S11: a kill naming an agent that is not running that claim is refused, and nothing fires", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ ...two, isTTY: true, claim: async () => ({ work: [unit("dev-bot-mdden", A), unit("spec-warden", B)], refused: [] }), startSession });
    await until(() => live.size === 2);
    captured.handler!({ kind: "kill", agent: "spec-warden", claim: A });
    expect(notes()).toContain("That session had already finished.");
    expect(live.get(A)!.reasons).toEqual([]);
    expect(live.get(B)!.reasons).toEqual([]);
    live.get(A)!.finish();
    live.get(B)!.finish();
    await running;
  });

  it("167-S12: a kill while the runner is stopping is refused, and the session ends as stopped rather than killed", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ isTTY: true, claim: async () => ({ work: [unit("dev-bot-mdden", A)], refused: [] }), startSession });
    await until(() => live.size === 1);
    process.emit("SIGTERM", "SIGTERM");
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: A });
    expect(notes()).toContain("The runner is stopping and is already ending every session.");
    expect(live.get(A)!.reasons).toEqual(["stop"]);
    const driven = await running;
    expect(driven.rows).toEqual([expect.objectContaining({ claim: A, outcome: "stopped" })]);
  });

  it("167-S13: the first stop wins — a kill during a time-out's grace leaves it a time-out, and signals nothing more", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { EventEmitter } = await import("node:events");
    const sent: Array<[number, string]> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: string) => {
      sent.push([pid, signal]);
      return true;
    }) as typeof process.kill);
    try {
      const child = Object.assign(new EventEmitter(), { pid: 424242, stdout: new EventEmitter(), stderr: new EventEmitter() });
      let stopper: ((reason: StopReason) => void) | null = null;
      const running = runSession(
        {
          spawnable: { command: "claude", args: [], env: {} },
          cwd,
          wallClockMs: 5,
          graceMs: 60_000,
          onStop: (given) => {
            stopper = given;
            return () => {};
          },
        },
        { spawn: (() => child) as unknown as typeof import("node:child_process").spawn, isWindows: false },
      );
      await until(() => sent.length === 1);
      stopper!("kill");
      child.emit("close", null);
      const ending = await running;
      expect(ending).toMatchObject({ timedOut: true, stoppedBy: null, signal: "term" });
      expect(sent).toEqual([[-424242, "SIGTERM"]]);
      expect(readOutcome({ ...ending, credentialVariable: null }).kind).toBe("timed-out");
    } finally {
      kill.mockRestore();
    }
  });

  it("167-S13, the other order: a wall clock running out during a kill's grace leaves it killed, and a stop then leaves it killed too", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { EventEmitter } = await import("node:events");
    const sent: Array<[number, string]> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: string) => {
      sent.push([pid, signal]);
      return true;
    }) as typeof process.kill);
    try {
      const child = Object.assign(new EventEmitter(), { pid: 424244, stdout: new EventEmitter(), stderr: new EventEmitter() });
      let stopper: ((reason: StopReason) => void) | null = null;
      const running = runSession(
        {
          spawnable: { command: "claude", args: [], env: {} },
          cwd,
          wallClockMs: 20,
          graceMs: 60_000,
          onStop: (given) => {
            stopper = given;
            return () => {};
          },
        },
        { spawn: (() => child) as unknown as typeof import("node:child_process").spawn, isWindows: false },
      );
      stopper!("kill");
      // Past the wall clock, inside the kill's grace.
      await new Promise((r) => setTimeout(r, 80));
      stopper!("stop");
      child.emit("close", null);
      const ending = await running;
      expect(ending).toMatchObject({ timedOut: false, stoppedBy: "person", signal: "term" });
      expect(sent).toEqual([[-424244, "SIGTERM"]]);
      expect(readOutcome({ ...ending, credentialVariable: null }).kind).toBe("killed");
    } finally {
      kill.mockRestore();
    }
  });

  it("a second kill of a session already being killed is refused out loud, and its stopper is not fired again", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ isTTY: true, claim: async () => ({ work: [unit("dev-bot-mdden", A)], refused: [] }), startSession });
    await until(() => live.size === 1);
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: A });
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: A });
    expect(notes()).toContain("That session is already ending.");
    expect(live.get(A)!.reasons).toEqual(["kill"]);
    const driven = await running;
    expect(driven.rows).toEqual([expect.objectContaining({ claim: A, outcome: "killed" })]);
  });

  it("a kill that lands after the harness exited, while its pipes drain, still signals the group and relabels nothing", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { EventEmitter } = await import("node:events");
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      const child = Object.assign(new EventEmitter(), { pid: 424243, stdout: new EventEmitter(), stderr: new EventEmitter() });
      let stopper: ((reason: StopReason) => void) | null = null;
      const running = runSession(
        {
          spawnable: { command: "claude", args: [], env: {} },
          cwd,
          wallClockMs: 60_000,
          onStop: (given) => {
            stopper = given;
            return () => {};
          },
        },
        { spawn: (() => child) as unknown as typeof import("node:child_process").spawn, isWindows: false },
      );
      child.stdout.emit("data", Buffer.from(good()));
      child.emit("exit", 0, null);
      // A straggler still holds the pipes, so the group is still there to end.
      stopper!("kill");
      stopper!("stop");
      child.emit("close", 0);
      const ending = await running;
      expect(ending).toMatchObject({ stoppedBy: null, signal: null });
      expect(kill.mock.calls).toEqual([[-424243, "SIGTERM"]]);
      expect(readOutcome({ ...ending, credentialVariable: null }).kind).toBe("done");
    } finally {
      kill.mockRestore();
    }
  });

  it("a late kill the straggler ignores is followed by SIGKILL after the grace, and still records no signal", async () => {
    vi.useFakeTimers();
    const { runSession } = await import("../src/run/execute.ts");
    const { EventEmitter } = await import("node:events");
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      const child = Object.assign(new EventEmitter(), { pid: 424247, stdout: new EventEmitter(), stderr: new EventEmitter() });
      let stopper: ((reason: StopReason) => void) | null = null;
      const running = runSession(
        {
          spawnable: { command: "claude", args: [], env: {} },
          cwd,
          wallClockMs: 600_000,
          graceMs: 30_000,
          onStop: (given) => {
            stopper = given;
            return () => {};
          },
        },
        { spawn: (() => child) as unknown as typeof import("node:child_process").spawn, isWindows: false },
      );
      child.stdout.emit("data", Buffer.from(good()));
      child.emit("exit", 0, null);
      stopper!("stop");
      vi.advanceTimersByTime(30_000);
      child.emit("close", 0);
      const ending = await running;
      expect(kill.mock.calls).toEqual([
        [-424247, "SIGTERM"],
        [-424247, "SIGKILL"],
      ]);
      expect(ending).toMatchObject({ stoppedBy: null, timedOut: false, signal: null });
      expect(readOutcome({ ...ending, credentialVariable: null }).kind).toBe("done");
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a late kill followed by the wall clock during its grace sends nothing after the session closed", async () => {
    // The late stop's SIGKILL timer is the one that must not survive `close`:
    // the group id is free for reuse by then. A second ending arriving during
    // the grace would replace that timer, and `close` would clear only the new one.
    vi.useFakeTimers();
    const { runSession } = await import("../src/run/execute.ts");
    const { EventEmitter } = await import("node:events");
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      const child = Object.assign(new EventEmitter(), { pid: 424244, stdout: new EventEmitter(), stderr: new EventEmitter() });
      let stopper: ((reason: StopReason) => void) | null = null;
      const running = runSession(
        {
          spawnable: { command: "claude", args: [], env: {} },
          cwd,
          wallClockMs: 60_000,
          graceMs: 30_000,
          onStop: (given) => {
            stopper = given;
            return () => {};
          },
        },
        { spawn: (() => child) as unknown as typeof import("node:child_process").spawn, isWindows: false },
      );
      child.stdout.emit("data", Buffer.from(good()));
      child.emit("exit", 0, null);
      vi.advanceTimersByTime(50_000);
      stopper!("kill");
      vi.advanceTimersByTime(15_000);
      child.emit("close", 0);
      vi.advanceTimersByTime(60_000);
      const ending = await running;
      expect(kill.mock.calls).toEqual([[-424244, "SIGTERM"]]);
      expect(ending).toMatchObject({ stoppedBy: null, timedOut: false, signal: null });
      expect(readOutcome({ ...ending, credentialVariable: null }).kind).toBe("done");
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("on Windows a stop that lands after the harness exited sends no taskkill", async () => {
    // `taskkill /T` walks the tree from the harness's pid, which is gone once it
    // has exited: it reaches no straggler, and the pid is free to name an
    // unrelated process whose whole tree `/F` would end.
    const spawned: string[][] = [];
    vi.resetModules();
    vi.doMock("node:child_process", async (original) => {
      const actual = await original<typeof import("node:child_process")>();
      const { EventEmitter } = await import("node:events");
      return {
        ...actual,
        spawn: ((command: string, args: string[]) => {
          spawned.push([command, ...args]);
          return new EventEmitter();
        }) as unknown as typeof actual.spawn,
      };
    });
    try {
      const { runSession } = await import("../src/run/execute.ts");
      const { EventEmitter } = await import("node:events");
      const session = (pid: number) => {
        const child = Object.assign(new EventEmitter(), { pid, stdout: new EventEmitter(), stderr: new EventEmitter() });
        let stopper: ((reason: StopReason) => void) | null = null;
        const running = runSession(
          {
            spawnable: { command: "claude", args: [], env: {} },
            cwd,
            wallClockMs: 60_000,
            onStop: (given) => {
              stopper = given;
              return () => {};
            },
          },
          { spawn: (() => child) as unknown as typeof import("node:child_process").spawn, isWindows: true },
        );
        return { child, running, stop: (reason: StopReason) => stopper!(reason) };
      };

      // A kill while the harness runs reaches it, which is what shows the stub is the one used.
      const early = session(424245);
      early.stop("kill");
      early.child.emit("exit", null, null);
      early.child.emit("close", null);
      await early.running;
      expect(spawned).toEqual([["taskkill", "/pid", "424245", "/T", "/F"]]);

      const late = session(424246);
      late.child.stdout.emit("data", Buffer.from(good()));
      late.child.emit("exit", 0, null);
      late.stop("kill");
      late.child.emit("close", 0);
      const ending = await late.running;
      expect(spawned).toHaveLength(1);
      expect(ending).toMatchObject({ stoppedBy: null, signal: null });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("167-S14: a kill starts the agent's next queued unit at once, under its own claim, with no hold and no poll between", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ isTTY: true, claim: async () => ({ work: [unit("dev-bot-mdden", A), unit("dev-bot-mdden", B)], refused: [] }), startSession });
    await until(() => live.size === 1);
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: A });
    await until(() => live.has(B));
    const kinds = captured.events.map((e) => (e.kind === "start" || e.kind === "failed" ? `${e.kind} ${e.claim}` : e.kind));
    const between = kinds.slice(kinds.indexOf(`failed ${A}`), kinds.indexOf(`start ${B}`));
    expect(between).not.toContain("poll");
    expect(between).not.toContain("phase");
    expect(kinds.indexOf(`failed ${A}`)).toBeLessThan(kinds.indexOf(`start ${B}`));
    live.get(B)!.finish();
    const driven = await running;
    expect(driven.rows.map((row) => [(row as { claim: string }).claim, (row as { outcome: string }).outcome])).toEqual([
      [A, "killed"],
      [B, "done"],
    ]);
  });

  it("167-S15: with something queued, the question says the next unit will start right away", async () => {
    const view = feed([{ kind: "configured", agent: "a" }, start("a", A), { kind: "queued", agent: "a", depth: 1 }]);
    const { lastFrame, stdin } = render(liveScreenFor(view));
    await settle();
    stdin.write(DOWN);
    await settle();
    stdin.write("k");
    await settle();
    expect(lastFrame() ?? "").toContain("Its next queued unit will start right away.");
    expect(killQuestion(view.agents[0], AT.getTime())).toContain(")? Its next queued unit will start right away. y to kill");
  });

  it("167-S16: with nothing queued, the question carries no queue sentence", async () => {
    const view = feed([{ kind: "configured", agent: "a" }, start("a", A)]);
    const { lastFrame, stdin } = render(liveScreenFor(view));
    await settle();
    stdin.write(DOWN);
    await settle();
    stdin.write("k");
    await settle();
    expect(lastFrame() ?? "").toContain("y to kill");
    expect(lastFrame() ?? "").not.toContain("queued unit");
    expect(killQuestion(view.agents[0], AT.getTime())).not.toContain("queued");
  });

  it("167-S17: the kill is said before the next unit's start, in the plain lines and on the live view", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ isTTY: true, claim: async () => ({ work: [unit("dev-bot-mdden", A), unit("dev-bot-mdden", B)], refused: [] }), startSession });
    await until(() => live.size === 1);
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: A });
    await until(() => live.has(B));
    live.get(B)!.finish();
    await running;

    const said = "killed dev-bot-mdden's session (claim 3f2a…); starting its next queued unit";
    const noteAt = captured.events.findIndex((e) => e.kind === "note" && e.message === said);
    const startAt = captured.events.findIndex((e) => e.kind === "start" && e.claim === B);
    expect(noteAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(startAt);

    const lines = captured.events.flatMap((event) => plainLine({ at: AT, event }) ?? []);
    const plainNote = lines.findIndex((line) => line.includes(`note      ${said}`));
    expect(plainNote).toBeGreaterThan(-1);
    expect(plainNote).toBeLessThan(lines.findIndex((line) => line.includes("start     dev-bot-mdden  claim 77e0…")));

    const onScreen = feed(captured.events.slice(0, startAt + 1));
    expect(onScreen.note).toBe(said);
    expect(onScreen.agents[0]).toMatchObject({ state: "running", claim: B });
  });

  it("167-S18: with nothing queued, the note names only the kill and nothing starts", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ isTTY: true, claim: async () => ({ work: [unit("dev-bot-mdden", A)], refused: [] }), startSession });
    await until(() => live.size === 1);
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: A });
    await running;
    expect(notes()).toContain("killed dev-bot-mdden's session (claim 3f2a…)");
    expect(notes().join(" ")).not.toContain("starting its next queued unit");
    expect(captured.events.filter((e) => e.kind === "start")).toHaveLength(1);
  });

  it("167-S19: an ending a person caused reads as killed, and says the session may have changed files", () => {
    const within = readOutcome(ending({ stoppedBy: "person", signal: "term" }));
    expect(within.kind).toBe("killed");
    expect(within.message).toBe(`You killed this session before it finished. ${MAY_HAVE_CHANGED_FILES}`);
    const after = readOutcome(ending({ stoppedBy: "person", signal: "kill" }));
    expect(after.message).toBe(`You killed this session; it did not stop when asked and was ended after 30 s. ${MAY_HAVE_CHANGED_FILES}`);
    const windows = readOutcome(ending({ stoppedBy: "person", signal: "kill", windows: true }));
    expect(windows.message).toBe(`You killed this session; on Windows it is ended at once. ${MAY_HAVE_CHANGED_FILES}`);
    expect(OUTCOME_KINDS).toContain("killed");
  });

  it("167-S20: a session the runner stopped prints as failed … stopped, not done, and its recent run says stopped", async () => {
    const stoppedByRunner: RunDeps["startSession"] = async (request) =>
      new Promise((resolve) => {
        request.onStop?.(() =>
          resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, stoppedBy: "runner", windows: false, signal: "term", spawnProblem: null }),
        );
        queueMicrotask(() => process.emit("SIGTERM", "SIGTERM"));
      });
    const plain = await drive({ startSession: stoppedByRunner });
    const text = plain.out.join("\n");
    expect(text).toMatch(/failed {4}dev-bot-mdden {2}claim c1f0 {2}stopped: The runner was stopping/);
    expect(text).not.toContain("done      dev-bot-mdden");

    await drive({ isTTY: true, startSession: stoppedByRunner });
    expect(captured.events.find((e) => e.kind === "failed")).toMatchObject({ claim: "c1f0", outcome: "stopped" });
    expect(captured.events.some((e) => e.kind === "done")).toBe(false);
    expect(feed(captured.events).recent[0]).toMatchObject({ claim: "c1f0", outcome: "stopped" });
  });

  it("167-S21: on Windows no stop, time-out or kill says the session did not stop when asked", () => {
    const said = [
      readOutcome(ending({ stoppedBy: "runner", signal: "kill", windows: true })),
      readOutcome(ending({ timedOut: true, signal: "kill", windows: true })),
      readOutcome(ending({ stoppedBy: "person", signal: "kill", windows: true })),
    ];
    expect(said.map((outcome) => outcome.kind)).toEqual(["stopped", "timed-out", "killed"]);
    for (const outcome of said) {
      expect(outcome.message).not.toContain("did not stop when asked");
      expect(outcome.message).toContain("on Windows");
    }
    // Elsewhere a SIGKILL after the grace is exactly what the sentence means.
    expect(readOutcome(ending({ timedOut: true, signal: "kill" })).message).toContain("did not stop when asked");
  });

  it("167-S22: a killed session under --once exits with the code a done one gives", async () => {
    const { live, startSession } = stoppable();
    const running = drive({ isTTY: true, startSession });
    await until(() => live.size === 1);
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: "c1f0" });
    const killedRun = await running;
    expect(killedRun.rows).toEqual([expect.objectContaining({ outcome: "killed" })]);
    expect(killedRun.code).toBe((await drive()).code);
    expect(killedRun.code).toBe(0);
  });

  it("167-S23: every run-log row carries the signal its outcome had", async () => {
    for (const signal of ["term", "kill", null] as const) {
      const outcome = readOutcome(ending({ stoppedBy: signal === null ? null : "person", signal, stdout: signal === null ? good() : "" }));
      expect(logRow(unit(), outcome, AT, AT).signal).toBe(signal);
      expect(JSON.parse(rowText(logRow(unit(), outcome, AT, AT))).signal).toBe(signal);
    }
    const { live, startSession } = stoppable();
    const running = drive({ isTTY: true, startSession });
    await until(() => live.size === 1);
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: "c1f0" });
    expect((await running).rows).toEqual([expect.objectContaining({ outcome: "killed", signal: "term" })]);
  });

  it("167-S24: a killed run offers r, and r goes through the one resume path", async () => {
    const run = pickedSession(
      feed([{ kind: "configured", agent: "a" }, { kind: "failed", agent: "a", claim: A, outcome: "killed", ms: 1000, message: "You killed it." }]),
      A,
    );
    expect(actionForKey("r", press(), run)).toEqual({ to: "resume" });
    expect(keyHints(run)).toContain("r — resume this run");

    const { waitFor } = await import("../src/commands/run.ts");
    const { live, startSession } = stoppable();
    let claimed = false;
    const running = drive(
      {
        isTTY: true,
        count: async () => ({ waiting: claimed ? 0 : 1, capped: false }),
        claim: async () => {
          claimed = true;
          return { work: [unit()], refused: [] };
        },
        startSession,
        sleep: waitFor,
      },
      { once: false },
    );
    await until(() => live.size === 1);
    captured.handler!({ kind: "kill", agent: "dev-bot-mdden", claim: "c1f0" });
    await until(() => ended("c1f0") !== undefined);
    // The run's row is written before its ending is announced, so the session is
    // resumable from here on.
    captured.handler!({ kind: "resume", agent: "dev-bot-mdden", claim: "c1f0" });
    await settle();
    process.emit("SIGTERM", "SIGTERM");
    const driven = await running;
    expect(driven.rows).toEqual([expect.objectContaining({ outcome: "killed" })]);
    expect(driven.resumesAsked).toEqual([expect.objectContaining({ agent: "dev-bot-mdden", claim: "c1f0", workspace: "01-ideas" })]);
  });
});

describe("run: the cost of a session cut short", () => {
  type Row = { costUsd: number | null; turns: number | null; costSource: string | null; turnsSource: string | null; usage?: unknown };
  const byModel = { "claude-opus-5-5": { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
  const cutShort = { stdout: "", stderr: "", exitCode: null, timedOut: false, stoppedBy: null, windows: false, signal: "kill" as const, spawnProblem: null };

  function recorder(answer: () => Promise<import("../src/run/log.ts").RecoveredUsage | null>) {
    const asked: Array<{ harness: string; claim: string; from: Date; to: Date }> = [];
    const recoverUsage: import("../src/commands/run.ts").RunDeps["recoverUsage"] = async (harness, claim, from, to) => {
      asked.push({ harness, claim, from, to });
      return answer();
    };
    return { asked, recoverUsage };
  }

  it("reads a spawned session's transcript when its harness reported no cost, and records what it found", async () => {
    const { asked, recoverUsage } = recorder(async () => ({ costUsd: 3.5, turns: 12, byModel }));
    const { rows } = await drive({
      startSession: async (request) => {
        request.onSpawned?.(5150);
        return cutShort;
      },
      recoverUsage,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ harness: "claude", claim: "c1f0" });
    expect(asked[0].from.getTime()).toBeLessThanOrEqual(asked[0].to.getTime());
    expect(rows[0] as Row).toMatchObject({ costUsd: 3.5, turns: 12, costSource: "transcript", turnsSource: "transcript", usage: byModel });
  });

  it("does not read the transcript when the harness reported a cost", async () => {
    const { asked, recoverUsage } = recorder(async () => ({ costUsd: 99, turns: 99, byModel }));
    const { rows } = await drive({
      startSession: async (request) => {
        request.onSpawned?.(5150);
        return { ...cutShort, stdout: good(), exitCode: 0, signal: null };
      },
      recoverUsage,
    });
    expect(asked).toEqual([]);
    expect(rows[0] as Row).toMatchObject({ costSource: "harness", turnsSource: "harness" });
  });

  it("does not look for a transcript of a session that never spawned", async () => {
    const { asked, recoverUsage } = recorder(async () => ({ costUsd: 1, turns: 1, byModel }));
    const { rows } = await drive({ startSession: async () => cutShort, recoverUsage });
    expect(asked).toEqual([]);
    expect(rows[0] as Row).toMatchObject({ costUsd: null, costSource: null });
  });

  it("still writes the row, with no cost, when the transcript cannot be read", async () => {
    const { recoverUsage } = recorder(async () => {
      throw new Error("EACCES");
    });
    const { rows } = await drive({
      startSession: async (request) => {
        request.onSpawned?.(5150);
        return cutShort;
      },
      recoverUsage,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0] as Row).toMatchObject({ costUsd: null, costSource: null, turnsSource: null });
  });
});

describe("run: runs that outlive the runner", () => {
  type InFlightRecord = import("../src/run/inflight.ts").InFlightRecord;
  type RunDeps = import("../src/commands/run.ts").RunDeps;
  type Ending = Awaited<ReturnType<RunDeps["startSession"]>>;

  const until = async (done: () => boolean) => {
    for (let i = 0; i < 400 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(done()).toBe(true);
  };
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
  };
  const press = (): KeyModifiers => ({ ctrl: false, upArrow: false, downArrow: false, escape: false });

  const ending = (over: Partial<Ending> = {}): Ending => ({
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    stoppedBy: null,
    windows: false,
    signal: null,
    spawnProblem: null,
    ...over,
  });
  const sessionEnd = (over: Partial<Ending> = {}): SessionEnd => ({ ...ending(over), credentialVariable: null });
  /** One ending per outcome a record is kept for, as the harness would leave it. */
  const cutShort: Record<"stopped" | "failed" | "timed-out" | "unreadable" | "killed", Partial<Ending>> = {
    stopped: { stoppedBy: "runner", signal: "term" },
    failed: { stderr: "boom", exitCode: 1 },
    "timed-out": { timedOut: true, signal: "term" },
    unreadable: { exitCode: 0 },
    killed: { stoppedBy: "person", signal: "term" },
  };

  const store = (initial: InFlightRecord[] = []) => {
    const records = new Map(initial.map((record) => [record.claim, record]));
    const log: string[] = [];
    const inFlight: RunDeps["inFlight"] = {
      write: async (record) => {
        records.set(record.claim, record);
        log.push(`write ${record.claim}`);
      },
      remove: async (claim) => {
        records.delete(claim);
        log.push(`remove ${claim}`);
      },
      list: async () => [...records.values()],
      lock: async () => null,
      nameHarness: async () => {},
      unlock: async () => {},
    };
    return { records, log, inFlight };
  };
  const spawning = (over: Partial<Ending>): RunDeps["startSession"] => async (request) => {
    request.onSpawned?.(5150);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return ending(over);
  };

  const kept = (over: Partial<InFlightRecord> = {}): InFlightRecord => ({
    claim: "3f2a0000-0000-4000-8000-000000000000",
    agentEntryId: "agent-1",
    agent: "dev-bot-mdden",
    workspace: "02-assessments",
    brain: "markdown brain",
    cwd,
    startedAt: "2026-09-04T09:00:00.000Z",
    ownerPid: null,
    harnessPid: null,
    resumes: 0,
    ended: "stopped",
    endedAt: "2026-09-04T09:10:00.000Z",
    ...over,
  });

  /** Run-log text as the real writer writes it, one row per claim and outcome, oldest first. */
  const logText = (rows: Array<{ claim: string; outcome: keyof typeof cutShort | "done"; agent?: string }>) =>
    rows
      .map(({ claim, outcome, agent }, i) => {
        const startedAt = new Date(Date.UTC(2026, 8, 4, 9, i * 10));
        const endedAt = new Date(startedAt.getTime() + 90_000);
        const read = readOutcome(sessionEnd(outcome === "done" ? { stdout: good(), exitCode: 0 } : cutShort[outcome]));
        return rowText(logRow(unit(agent, claim), read, startedAt, endedAt));
      })
      .join("");

  it("176-S1: a resumable ending keeps the record, disowned, with the ending on it", async () => {
    for (const outcome of ["stopped", "failed", "timed-out", "unreadable"] as const) {
      const { records, log, inFlight } = store();
      await drive({ inFlight, startSession: spawning(cutShort[outcome]) });
      expect(log).toEqual(["write c1f0", "write c1f0"]);
      expect(records.get("c1f0")).toEqual(
        expect.objectContaining({ claim: "c1f0", agentEntryId: "agent-1", ownerPid: null, harnessPid: null, ended: outcome, endedAt: expect.any(String) }),
      );
    }
  });

  it("176-S2: a session that ends done, or fails to spawn after it started, has its record removed", async () => {
    const done = store();
    await drive({ inFlight: done.inFlight, startSession: spawning({ stdout: good(), exitCode: 0 }) });
    expect(done.log).toEqual(["write c1f0", "remove c1f0"]);
    expect(done.records.size).toBe(0);

    const spawnFailed = store();
    await drive({
      inFlight: spawnFailed.inFlight,
      startSession: async (request) => {
        request.onSpawned?.(5150);
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new Error("the spawner fell over");
      },
    });
    expect(spawnFailed.log).toEqual(["write c1f0", "remove c1f0"]);
  });

  it("176-S3: a killed session keeps its record too", async () => {
    const { records, inFlight } = store();
    await drive({ inFlight, startSession: spawning(cutShort.killed) });
    expect(records.get("c1f0")).toEqual(expect.objectContaining({ ownerPid: null, harnessPid: null, ended: "killed" }));
  });

  it("176-S4: the record is kept when the run log cannot be written, and the log's note is said", async () => {
    const { records, inFlight } = store();
    const driven = await drive({
      inFlight,
      recordRun: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
      startSession: spawning(cutShort.stopped),
    });
    expect(records.get("c1f0")).toEqual(expect.objectContaining({ ownerPid: null, ended: "stopped" }));
    expect(driven.out.join("\n")).toContain("The run log could not be written: ENOSPC");
  });

  it("176-S7: the next run's note says a session was stopped with the runner, and points at mdbrain resume", async () => {
    const { inFlight } = store([kept()]);
    const driven = await drive({ inFlight, count: async () => ({ waiting: 0, capped: false }) });
    const said = driven.out.filter((line) => line.includes("mdbrain resume"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("dev-bot-mdden's session 3f2a… was stopped with the runner.");
    expect(driven.spawned).toEqual([]);
  });

  it("176-S9: the view opens with the last five runs of the log, newest first, done ones included", async () => {
    const claims = Array.from({ length: 8 }, (_, i) => `c${i}00`);
    const text = logText(claims.map((claim, i) => ({ claim, outcome: i % 2 === 0 ? "done" : "failed" })));
    await drive({ isTTY: true, readRunLog: async () => text, count: async () => ({ waiting: 0, capped: false }) });
    expect(captured.initial.map((run) => run.claim)).toEqual(["c700", "c600", "c500", "c400", "c300"]);
    expect(captured.initial.map((run) => run.outcome)).toEqual(["failed", "done", "failed", "done", "failed"]);
    expect(captured.initial[1]).toEqual(
      expect.objectContaining({ agent: "dev-bot-mdden", ms: 90_000, costUsd: expect.any(Number), message: expect.any(String), at: new Date(Date.UTC(2026, 8, 4, 10, 1, 30)) }),
    );
  });

  it("176-S10: a row for an agent this run does not ask for is restored too", async () => {
    const text = logText([{ claim: "c100", outcome: "done", agent: "ux-critic" }]);
    await drive({ isTTY: true, readRunLog: async () => text, count: async () => ({ waiting: 0, capped: false }) });
    expect(captured.initial).toEqual([expect.objectContaining({ agent: "ux-critic", claim: "c100" })]);
  });

  it("176-S11: a bad line is skipped and the parseable rows nearest the end are shown; no log, or one that cannot be read, is an empty list and nothing said", async () => {
    const lines = logText(Array.from({ length: 6 }, (_, i) => ({ claim: `c${i}00`, outcome: "done" as const }))).split("\n");
    lines.splice(4, 0, "{ not json", JSON.stringify({ claim: "c999", agent: "a", outcome: "exploded" }));
    expect(parseRunLog(lines.join("\n")).map((row) => row.claim)).toEqual(["c000", "c100", "c200", "c300", "c400", "c500"]);
    expect(restoredRecent(parseRunLog(lines.join("\n")), []).map((run) => run.claim)).toEqual(["c500", "c400", "c300", "c200", "c100"]);

    const root = mkdtempSync(join(tmpdir(), "mdbrain-run-log-"));
    try {
      expect(await readRunLog({ platform: process.platform, home: root, env: { MDBRAIN_STATE_DIR: root } })).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const unreadable = await drive({
      isTTY: true,
      readRunLog: async () => {
        throw new Error("EACCES: permission denied");
      },
      count: async () => ({ waiting: 0, capped: false }),
    });
    expect(captured.initial).toEqual([]);
    expect(captured.events.some((event) => event.kind === "note" && event.message.includes("EACCES"))).toBe(false);
    expect(unreadable.code).toBe(0);
  });

  it("176-S12: the plain presenter prints nothing for a restored row", async () => {
    const text = logText([{ claim: "c100", outcome: "failed" }]);
    const without = await drive({ count: async () => ({ waiting: 0, capped: false }) });
    const readRunLog = vi.fn(async () => text);
    const restoring = await drive({ readRunLog, count: async () => ({ waiting: 0, capped: false }) });
    const strip = (lines: string[]) => lines.map((line) => line.replace(/^\d\d:\d\d:\d\d /, ""));
    expect(strip(restoring.out)).toEqual(strip(without.out));
    // With nobody to show them to, the log is not read at all.
    expect(readRunLog).not.toHaveBeenCalled();
  });

  it("r on a restored row whose record another window has since finished or dismissed resumes nothing, and says so", async () => {
    const record = kept();
    const text = logText([{ claim: record.claim, outcome: "stopped" }]);
    const { waitFor } = await import("../src/commands/run.ts");
    const { records, inFlight } = store([record]);
    const running = drive(
      { isTTY: true, inFlight, readRunLog: async () => text, count: async () => ({ waiting: 0, capped: false }), sleep: waitFor },
      { once: false },
    );
    await until(() => captured.handler !== null);
    expect(captured.initial[0].resumable).toBe(true);
    records.delete(record.claim);

    captured.handler!({ kind: "resume", agent: "dev-bot-mdden", claim: record.claim });
    await settle();
    process.emit("SIGTERM", "SIGTERM");
    const driven = await running;
    expect(driven.resumesAsked).toEqual([]);
    expect(captured.events).toContainEqual(expect.objectContaining({ kind: "note", message: expect.stringContaining("no longer recorded on this machine") }));
  });

  it("r on a run this process kept, whose record another window has since finished or dismissed, resumes nothing, and says so", async () => {
    const { waitFor } = await import("../src/commands/run.ts");
    const { records, inFlight } = store();
    let claimed = false;
    const running = drive(
      {
        isTTY: true,
        inFlight,
        count: async () => ({ waiting: claimed ? 0 : 1, capped: false }),
        claim: async () => {
          claimed = true;
          return { work: [unit()], refused: [] };
        },
        startSession: spawning(cutShort.failed),
        sleep: waitFor,
      },
      { once: false },
    );
    await until(() => records.get("c1f0")?.ended === "failed");
    await settle();
    // Kept records are listed by `mdbrain resume` everywhere, so this is another window finishing it.
    records.delete("c1f0");

    captured.handler!({ kind: "resume", agent: "dev-bot-mdden", claim: "c1f0" });
    await settle();
    process.emit("SIGTERM", "SIGTERM");
    const driven = await running;
    expect(driven.resumesAsked).toEqual([]);
    expect(captured.events).toContainEqual(expect.objectContaining({ kind: "note", message: expect.stringContaining("no longer recorded on this machine") }));
  });

  it("r on a run this process kept, whose record is still there, resumes it", async () => {
    const { waitFor } = await import("../src/commands/run.ts");
    const { records, inFlight } = store();
    let claimed = false;
    const running = drive(
      {
        isTTY: true,
        inFlight,
        count: async () => ({ waiting: claimed ? 0 : 1, capped: false }),
        claim: async () => {
          claimed = true;
          return { work: [unit()], refused: [] };
        },
        startSession: spawning(cutShort.failed),
        sleep: waitFor,
      },
      { once: false },
    );
    await until(() => records.get("c1f0")?.ended === "failed");
    await settle();

    captured.handler!({ kind: "resume", agent: "dev-bot-mdden", claim: "c1f0" });
    await settle();
    process.emit("SIGTERM", "SIGTERM");
    const driven = await running;
    expect(driven.resumesAsked).toEqual([expect.objectContaining({ agent: "dev-bot-mdden", claim: "c1f0" })]);
  });

  it("176-S13: r on a restored stopped row is offered, and reaches the one resume path with the record's workspace, brain and cwd", async () => {
    const record = kept();
    const text = logText([{ claim: record.claim, outcome: "stopped" }]);
    const { waitFor } = await import("../src/commands/run.ts");
    const { inFlight } = store([record]);
    const running = drive(
      { isTTY: true, inFlight, readRunLog: async () => text, count: async () => ({ waiting: 0, capped: false }), sleep: waitFor },
      { once: false },
    );
    await until(() => captured.handler !== null);
    const [run] = captured.initial;
    expect(run).toEqual(expect.objectContaining({ claim: record.claim, outcome: "stopped", resumable: true }));
    expect(actionForKey("r", press(), { kind: "recent", run })).toEqual({ to: "resume" });

    captured.handler!({ kind: "resume", agent: "dev-bot-mdden", claim: record.claim });
    await settle();
    process.emit("SIGTERM", "SIGTERM");
    const driven = await running;
    expect(driven.resumesAsked).toEqual([
      expect.objectContaining({ agent: "dev-bot-mdden", claim: record.claim, workspace: "02-assessments", brain: "markdown brain", cwd }),
    ]);
  });

  it("176-S14: a restored failed row with no record for its claim offers no r", () => {
    const [run] = restoredRecent(parseRunLog(logText([{ claim: "c100", outcome: "failed" }])), []);
    expect(run.resumable).toBe(false);
    expect(actionForKey("r", press(), { kind: "recent", run })).toBeNull();
    expect(keyHints({ kind: "recent", run }).join(" ")).not.toContain("resume");
  });

  it("176-S15: a restored done row never offers r, whatever records exist", () => {
    const record = kept();
    const [run] = restoredRecent(parseRunLog(logText([{ claim: record.claim, outcome: "done" }])), [record]);
    expect(run.resumable).toBe(false);
    expect(actionForKey("r", press(), { kind: "recent", run })).toBeNull();
  });

  it("a restored row offers r only for a disowned record, and only for one still under its own agent's entry", async () => {
    const record = kept();
    const text = logText([{ claim: record.claim, outcome: "stopped" }]);
    // Still owned by a live process: running somewhere, not something to resume.
    expect(restoredRecent(parseRunLog(text), [kept({ ownerPid: 999 })])[0].resumable).toBe(false);

    // The name now belongs to a different entry, which must not be handed this transcript.
    await drive({
      isTTY: true,
      inFlight: store([kept({ agentEntryId: "agent-gone" })]).inFlight,
      readRunLog: async () => text,
      count: async () => ({ waiting: 0, capped: false }),
    });
    expect(captured.initial[0].resumable).toBe(false);
  });

  it("176-S16: a stopped session's message says it may have changed files, on every platform and signal", () => {
    for (const over of [{ signal: "term" }, { signal: "kill" }, { windows: true, signal: "kill" }] as const) {
      const read = readOutcome(sessionEnd({ stoppedBy: "runner", ...over }));
      expect(read.kind).toBe("stopped");
      expect(read.message).toContain(MAY_HAVE_CHANGED_FILES);
      expect(read.message).toContain("It may have changed files before it stopped.");
    }
  });
});

describe("177: no limits unless asked for", () => {
  it("177-S5: no turns flag, ever", () => {
    for (const limits of [{}, { maxBudgetUsd: 20 }, { maxBudgetUsd: 20, wallClock: "2h" }, { wallClock: "30m" }]) {
      expect(claudeHarness.build(invocation({ limits })).args).not.toContain("--max-turns");
    }
  });

  it("177-S6: the budget flag only when one is set", () => {
    expect(claudeHarness.build(invocation({ limits: {} })).args).not.toContain("--max-budget-usd");
    expect(claudeHarness.build(invocation({ limits: { wallClock: "2h" } })).args).not.toContain("--max-budget-usd");
    const args = claudeHarness.build(invocation({ limits: { maxBudgetUsd: 20 } })).args;
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("20");
  });

  it("177-S7: an agent with no wall clock is started with none, and one with 2h is started with 2 hours", async () => {
    const asked: Array<number | null> = [];
    const startSession = async (request: { wallClockMs: number | null }) => {
      asked.push(request.wallClockMs);
      return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null };
    };
    await drive({ startSession });
    await drive({
      loadConfiguration: async () => ({ kind: "config", config: config({ "dev-bot-mdden": entry({ limits: { wallClock: "2h" } }) }) }),
      startSession,
    });
    expect(asked).toEqual([null, 2 * 3_600_000]);
  });

  it("177-S7: runSession arms no timer for a null wall clock, so the session ends on its own", async () => {
    const { runSession } = await import("../src/run/execute.ts");
    const { spawn } = await import("node:child_process");
    const ended = await runSession(
      {
        spawnable: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 300)"], env: { PATH: process.env.PATH ?? "" } },
        cwd: process.cwd(),
        wallClockMs: null,
      },
      { spawn, isWindows: process.platform === "win32" },
    );
    expect(ended.timedOut).toBe(false);
    expect(ended.exitCode).toBe(0);
  }, 20_000);

  it("177-S8: a file still holding the old limits is reported once in the summary, and a file without them says nothing", async () => {
    const { OLD_LIMITS_LINE } = await import("../src/run/loop.ts");
    const old = await drive({ loadConfiguration: async () => ({ kind: "config", config: config(), oldLimits: true }) });
    const said = old.out.filter((line) => line.includes("still has limits written by an earlier mdbrain"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(OLD_LIMITS_LINE);
    expect(said[0]).toContain("mdbrain configure");

    const fresh = await drive();
    expect(fresh.out.join("\n")).not.toContain("earlier mdbrain");
  });

  /** A session that runs for `hours` of fake time once spawned, and everything `run` printed. */
  async function sessionOf(hours: number, limits: Record<string, string>) {
    vi.useFakeTimers();
    try {
      const running = drive({
        loadConfiguration: async () => ({ kind: "config", config: config({ "dev-bot-mdden": entry({ limits }) }) }),
        startSession: async (request) => {
          request.onSpawned?.(4242);
          await new Promise((resolve) => setTimeout(resolve, hours * 3_600_000));
          return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null };
        },
      });
      // In hour steps, so a note that repeated on any timer of its own would be
      // given every chance to.
      for (let h = 0; h <= hours + 1; h += 1) await vi.advanceTimersByTimeAsync(3_600_000);
      return (await running).out;
    } finally {
      vi.useRealTimers();
    }
  }

  it("177-S9: a long session with no time limit is noted once, at 2 hours, naming the agent and the short claim", async () => {
    const { NO_LIMIT_NOTE_MS, noLimitNote } = await import("../src/run/loop.ts");
    expect(NO_LIMIT_NOTE_MS).toBe(2 * 3_600_000);
    expect(noLimitNote("dev-bot-mdden", "3f2a0000-0000")).toBe("dev-bot-mdden's session (claim 3f2a…) has run 2h with no time limit set.");
    // Past 4 hours, so a note repeated on a 2-hour interval would be said twice.
    const out = await sessionOf(4.5, {});
    const notes = out.filter((line) => line.includes("with no time limit set"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("dev-bot-mdden's session (claim c1f0…) has run 2h");
  }, 30_000);

  it("177-S9: a session with no time limit that ends before 2 hours is never noted, even with run still up long after", async () => {
    vi.useFakeTimers();
    try {
      const running = drive({
        loadConfiguration: async () => ({ kind: "config", config: config({ "dev-bot-mdden": entry({ limits: {} }) }) }),
        startSession: async (request) => {
          request.onSpawned?.(4242);
          await new Promise((resolve) => setTimeout(resolve, 3_600_000));
          return { stdout: good(), stderr: "", exitCode: 0, timedOut: false, stoppedBy: null, windows: false, signal: null, spawnProblem: null };
        },
      });
      for (let h = 0; h < 2; h += 1) await vi.advanceTimersByTimeAsync(3_600_000);
      const { out } = await running;
      // The note's timer is armed at spawn, so a session that has ended has to
      // take it with it, or the note names a session that finished hours ago.
      for (let h = 0; h < 3; h += 1) await vi.advanceTimersByTimeAsync(3_600_000);
      expect(out.join("\n")).not.toContain("with no time limit set");
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("177-S10: a session with a wall clock is not noted, however long it runs", async () => {
    const out = await sessionOf(3.5, { wallClock: "4h" });
    expect(out.join("\n")).not.toContain("with no time limit set");
  }, 30_000);
});
