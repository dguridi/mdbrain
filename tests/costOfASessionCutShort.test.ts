import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeHarness } from "../src/run/harness.ts";
import { logRow } from "../src/run/log.ts";
import { readOutcome } from "../src/run/outcome.ts";
import { MODEL_PRICES, priceUsage } from "../src/run/price.ts";
import { baseModel, claudeProjectsDir, readTranscriptUsage, transcriptUsage } from "../src/run/transcript.ts";
import type { WorkUnit } from "../src/work/instruction.ts";

const from = new Date("2026-10-16T10:00:00.000Z");
const to = new Date("2026-10-16T10:30:00.000Z");

/** One transcript line for an assistant message's content block, as Claude Code writes it. */
function line(over: {
  id: string;
  at?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cache5m?: number;
  cache1h?: number;
  block?: { type: string; id?: string };
}): string {
  const usage = {
    input_tokens: over.input ?? 0,
    output_tokens: over.output ?? 0,
    cache_read_input_tokens: over.cacheRead ?? 0,
    cache_creation_input_tokens: (over.cache5m ?? 0) + (over.cache1h ?? 0),
    cache_creation: { ephemeral_5m_input_tokens: over.cache5m ?? 0, ephemeral_1h_input_tokens: over.cache1h ?? 0 },
  };
  return JSON.stringify({
    type: "assistant",
    timestamp: over.at ?? "2026-10-16T10:05:00.000Z",
    message: { id: over.id, model: over.model ?? "claude-opus-5-5", usage, content: [over.block ?? { type: "text" }] },
  });
}

const text = (...lines: string[]) => `${lines.join("\n")}\n`;

describe("the transcript's usage", () => {
  it("counts one message once, from its last line, though each content block repeats it", () => {
    const usage = transcriptUsage(
      text(
        line({ id: "m1", input: 10, output: 8, block: { type: "thinking" } }),
        line({ id: "m1", input: 10, output: 300, block: { type: "tool_use", id: "t1" } }),
      ),
      [],
      from,
      to,
    );
    expect(usage.messages).toBe(1);
    expect(usage.byModel["claude-opus-5-5"]).toEqual({ input: 10, output: 300, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    expect(usage.toolUses).toBe(1);
  });

  it("skips a synthetic message and any line that is not an assistant message", () => {
    const usage = transcriptUsage(
      text(
        line({ id: "m1", model: "<synthetic>", input: 99 }),
        JSON.stringify({ type: "user", timestamp: "2026-10-16T10:05:00.000Z", message: { content: "hi" } }),
        "not json",
        line({ id: "m2", input: 5 }),
      ),
      [],
      from,
      to,
    );
    expect(Object.keys(usage.byModel)).toEqual(["claude-opus-5-5"]);
    expect(usage.byModel["claude-opus-5-5"].input).toBe(5);
    expect(usage.messages).toBe(1);
  });

  it("counts only the messages inside the session's own window, so a later resume is not its spend", () => {
    const usage = transcriptUsage(
      text(line({ id: "m1", input: 7 }), line({ id: "m2", input: 1000, at: "2026-10-16T11:00:00.000Z" }), line({ id: "m0", input: 1000, at: "2026-10-16T09:59:59.000Z" })),
      [],
      from,
      to,
    );
    expect(usage.byModel["claude-opus-5-5"].input).toBe(7);
  });

  it("adds subagents' tokens, but not their tool calls, which the harness's turn count does not follow", () => {
    const usage = transcriptUsage(
      text(line({ id: "m1", input: 1, block: { type: "tool_use", id: "t1" } })),
      [text(line({ id: "s1", input: 2, block: { type: "tool_use", id: "t9" } }))],
      from,
      to,
    );
    expect(usage.byModel["claude-opus-5-5"].input).toBe(3);
    expect(usage.toolUses).toBe(1);
  });

  it("keeps the two cache-write lifetimes apart, and reads a message with no split as five-minute writes", () => {
    const noSplit = JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-16T10:05:00.000Z",
      message: { id: "m2", model: "claude-opus-5-5", usage: { cache_creation_input_tokens: 40 }, content: [] },
    });
    const usage = transcriptUsage(text(line({ id: "m1", cache5m: 3, cache1h: 4 }), noSplit), [], from, to);
    expect(usage.byModel["claude-opus-5-5"]).toMatchObject({ cacheWrite5m: 43, cacheWrite1h: 4 });
  });

  it("prices the [1m] context variant as its model", () => {
    expect(baseModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    const usage = transcriptUsage(text(line({ id: "m1", model: "claude-opus-5-5[1m]", input: 1 })), [], from, to);
    expect(Object.keys(usage.byModel)).toEqual(["claude-opus-5-5"]);
  });
});

describe("the price table", () => {
  it("prices each kind of token at its model's rate", () => {
    // A million of each, so the sum reads as the table: 4 + 20 + 0.2 + 4×1.25 + 4×2.
    const million = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
    expect(priceUsage({ "claude-opus-5-5": million })).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 10);
    expect(priceUsage({ "claude-fable-5-1": { ...million, cacheWrite5m: 0, cacheWrite1h: 0 } })).toBeCloseTo(10 + 50 + 0.25, 10);
  });

  it("holds exactly the three models whose prices were checked against reported costs", () => {
    expect(Object.keys(MODEL_PRICES).sort()).toEqual(["claude-fable-5-1", "claude-opus-5", "claude-opus-5-5"]);
  });

  it("answers null rather than a partial sum when a model that spent something is unknown", () => {
    const some = { input: 10, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(priceUsage({ "claude-opus-5-5": some, "claude-sonnet-5": some })).toBeNull();
    // A model that spent nothing does not stop the rest being priced.
    expect(priceUsage({ "claude-opus-5-5": some, "claude-sonnet-5": { ...some, input: 0 } })).toBeCloseTo(0.00004, 12);
  });
});

describe("the run-log row", () => {
  const unit = (): WorkUnit =>
    ({
      kind: "file-arrived",
      seq: 1,
      at: "2026-10-16T10:00:00.000Z",
      instruction: { claim: "c1f0", workspace: "01-ideas", agent: "dev-bot-mdden", prompt: "p", file: null },
    }) as unknown as WorkUnit;
  const byModel = { "claude-opus-5-5": { input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
  const cutShort = () => readOutcome({ stdout: "", stderr: "", exitCode: null, timedOut: false, stoppedBy: "runner", windows: false, signal: "kill", credentialVariable: "ANTHROPIC_API_KEY" });

  it("records a recovered cost and turns, says so, and keeps the tokens they came from", () => {
    const row = logRow(unit(), cutShort(), from, to, { costUsd: 1.25, turns: 7, byModel });
    expect(row).toMatchObject({ costUsd: 1.25, turns: 7, costSource: "transcript", turnsSource: "transcript", usage: byModel });
  });

  it("never replaces a cost the harness reported", () => {
    const reported = { ...cutShort(), costUsd: 0.42, turns: 3 };
    const row = logRow(unit(), reported, from, to, { costUsd: 9, turns: 9, byModel });
    expect(row).toMatchObject({ costUsd: 0.42, turns: 3, costSource: "harness", turnsSource: "harness" });
    expect(row.usage).toBeUndefined();
  });

  it("keeps the tokens when the model was not priced, so the row can be priced later", () => {
    const row = logRow(unit(), cutShort(), from, to, { costUsd: null, turns: 4, byModel });
    expect(row).toMatchObject({ costUsd: null, costSource: null, turns: 4, turnsSource: "transcript", usage: byModel });
  });

  it("says nothing recovered when nothing was", () => {
    const row = logRow(unit(), cutShort(), from, to);
    expect(row).toMatchObject({ costUsd: null, turns: null, costSource: null, turnsSource: null });
    expect(row.usage).toBeUndefined();
  });
});

describe("reading a session's transcript from disk", () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root !== null) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("finds the claim's transcript in whichever project folder holds it, with its subagents", async () => {
    root = await mkdtemp(join(tmpdir(), "mdbrain-transcripts-"));
    const projects = join(root, "projects");
    await mkdir(join(projects, "C--elsewhere"), { recursive: true });
    await mkdir(join(projects, "c--work-checkout", "c1f0", "subagents"), { recursive: true });
    await writeFile(join(projects, "C--elsewhere", "other.jsonl"), text(line({ id: "x", input: 999 })));
    await writeFile(join(projects, "c--work-checkout", "c1f0.jsonl"), text(line({ id: "m1", input: 10, block: { type: "tool_use", id: "t1" } })));
    await writeFile(join(projects, "c--work-checkout", "c1f0", "subagents", "agent-a.jsonl"), text(line({ id: "s1", input: 5 })));

    const usage = await readTranscriptUsage(projects, "c1f0", from, to);
    expect(usage?.byModel["claude-opus-5-5"].input).toBe(15);

    const recovered = await claudeHarness.recoverUsage!("c1f0", from, to, { platform: "linux", home: "/nowhere", env: { CLAUDE_CONFIG_DIR: root } });
    expect(recovered).toMatchObject({ turns: 2 });
    expect(recovered?.costUsd).toBeCloseTo((15 * 4) / 1e6, 12);
  });

  it("answers null when no transcript of the claim exists, or nothing is in its window", async () => {
    root = await mkdtemp(join(tmpdir(), "mdbrain-transcripts-"));
    expect(await readTranscriptUsage(join(root, "projects"), "c1f0", from, to)).toBeNull();
    await mkdir(join(root, "projects", "p"), { recursive: true });
    await writeFile(join(root, "projects", "p", "c1f0.jsonl"), text(line({ id: "m1", at: "2026-10-17T00:00:00.000Z" })));
    expect(await claudeHarness.recoverUsage!("c1f0", from, to, { platform: "linux", home: "/nowhere", env: { CLAUDE_CONFIG_DIR: root } })).toBeNull();
  });

  it("looks under CLAUDE_CONFIG_DIR when it is set, and under ~/.claude otherwise", () => {
    expect(claudeProjectsDir({ platform: "linux", home: "/home/d", env: {} })).toBe(join("/home/d", ".claude", "projects"));
    expect(claudeProjectsDir({ platform: "linux", home: "/home/d", env: { CLAUDE_CONFIG_DIR: "/cfg" } })).toBe(join("/cfg", "projects"));
  });
});

describe("what is not priced, and why", () => {
  it("keeps a fast-mode message's tokens under a key of their own, which prices as null rather than at the standard rate", () => {
    const fast = JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-16T10:05:00.000Z",
      message: { id: "m2", model: "claude-opus-5-5", usage: { input_tokens: 9, speed: "fast" }, content: [] },
    });
    const usage = transcriptUsage(text(line({ id: "m1", input: 1 }), fast), [], from, to);
    expect(usage.byModel["claude-opus-5-5@fast"]?.input).toBe(9);
    expect(usage.byModel["claude-opus-5-5"].input).toBe(1);
    expect(priceUsage(usage.byModel)).toBeNull();
  });

  it("reads a cache-write object that names neither lifetime as the total, at the five-minute rate", () => {
    const empty = JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-16T10:05:00.000Z",
      message: { id: "m1", model: "claude-opus-5-5", usage: { cache_creation_input_tokens: 50, cache_creation: {} }, content: [] },
    });
    expect(transcriptUsage(text(empty), [], from, to).byModel["claude-opus-5-5"]).toMatchObject({ cacheWrite5m: 50, cacheWrite1h: 0 });
  });

  it("reports no turns when only subagents wrote anything in the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbrain-transcripts-"));
    try {
      await mkdir(join(root, "projects", "p", "c1f0", "subagents"), { recursive: true });
      await writeFile(join(root, "projects", "p", "c1f0.jsonl"), "");
      await writeFile(join(root, "projects", "p", "c1f0", "subagents", "a.jsonl"), text(line({ id: "s1", input: 3 })));
      const recovered = await claudeHarness.recoverUsage!("c1f0", from, to, { platform: "linux", home: "/nowhere", env: { CLAUDE_CONFIG_DIR: root } });
      expect(recovered).toMatchObject({ turns: null });
      expect(recovered?.costUsd).toBeCloseTo((3 * 4) / 1e6, 12);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
