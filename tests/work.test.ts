import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UNREADABLE_WORK_MESSAGE, agentsToAsk, readWork } from "../src/work/instruction.ts";

const unit = (over: Record<string, unknown> = {}, instruction: Record<string, unknown> = {}) => ({
  kind: "file-arrived",
  seq: 8412,
  at: "2026-09-02T01:00:00.000Z",
  instruction: { claim: "c1f0", workspace: "ws-1", agent: "dev-bot-mdden", prompt: "Triage what landed.", ...instruction },
  ...over,
});

const refusal = (over: Record<string, unknown> = {}) => ({
  agent: "dev-bot-mdden",
  workspace: "ws-1",
  by: "runner",
  cap: 10,
  sessionsThisHour: 10,
  heldBack: 2,
  reason: "dev-bot-mdden: 2 units of work held back.",
  ...over,
});

describe("reading the claim's answer", () => {
  it("80-S26: the prompt is read off the instruction, and the module opens no file to get it", () => {
    const reading = readWork({ work: [unit()], refused: [] });
    expect(reading.kind).toBe("work");
    if (reading.kind !== "work") return;
    expect(reading.work[0].instruction.prompt).toBe("Triage what landed.");
    expect(reading.work[0].instruction).toEqual({
      claim: "c1f0",
      workspace: "ws-1",
      agent: "dev-bot-mdden",
      prompt: "Triage what landed.",
      file: null,
    });

    // The runner never reads brain-config.yaml: the module that reads the
    // instruction has no file, clock or socket in it, so there is nothing it
    // could have read the prompt from but the answer it was handed.
    const source = readFileSync(fileURLToPath(new URL("../src/work/instruction.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/^import .*(node:fs|node:net|node:http|fetch)/m);
    expect(source).not.toMatch(/brain-config/);
  });

  it("keeps the envelope, so a wake can be named in a log", () => {
    const reading = readWork({ work: [unit()] });
    if (reading.kind !== "work") throw new Error(reading.message);
    expect(reading.work[0]).toMatchObject({ kind: "file-arrived", seq: 8412, at: "2026-09-02T01:00:00.000Z" });
  });

  it("an empty answer is no work, which is the ordinary case", () => {
    expect(readWork({ work: [] })).toEqual({ kind: "work", work: [], refused: [] });
  });

  it("carries the refusals through, with the sentence to print", () => {
    const reading = readWork({ work: [], refused: [refusal()] });
    if (reading.kind !== "work") throw new Error(reading.message);
    expect(reading.refused).toEqual([
      { agent: "dev-bot-mdden", workspace: "ws-1", by: "runner", heldBack: 2, reason: "dev-bot-mdden: 2 units of work held back." },
    ]);
  });

  it("refuses the whole answer when any instruction lacks one of the four things a session needs", () => {
    for (const missing of ["claim", "workspace", "agent", "prompt"]) {
      const broken = unit({}, { [missing]: undefined });
      expect(readWork({ work: [unit(), broken] }), missing).toEqual({ kind: "unreadable", message: UNREADABLE_WORK_MESSAGE });
    }
  });

  it("refuses an answer that is not the claim's shape at all", () => {
    for (const body of [null, "work", [], { work: "none" }, { work: [{ prompt: "bare" }] }, { work: [], refused: "no" }]) {
      expect(readWork(body).kind, JSON.stringify(body)).toBe("unreadable");
    }
  });

  it("refuses a refusal it could not print, rather than swallowing what it was told to say", () => {
    expect(readWork({ work: [], refused: [refusal({ by: "weather" })] }).kind).toBe("unreadable");
    expect(readWork({ work: [], refused: [refusal({ reason: "" })] }).kind).toBe("unreadable");
  });

  it("105-S72: carries the file the event names, and reads its absence as null", () => {
    const named = readWork({ work: [unit({}, { file: { id: "9f1e", path: "01-ideas/37-a-doctor.md" } })] });
    expect(named.kind).toBe("work");
    if (named.kind !== "work") return;
    expect(named.work[0].instruction.file).toEqual({ id: "9f1e", path: "01-ideas/37-a-doctor.md" });

    // A server that has never heard of the field is still readable: the four
    // fields a session needs are all there, and this is not one of them.
    expect((readWork({ work: [unit()] }) as { work: { instruction: { file: unknown } }[] }).work[0].instruction.file).toBeNull();
  });

  it("105-S73: a file it cannot shape is refused, not half-read", () => {
    // Half of this is worse than none: a path with no id cannot be followed back
    // and an id with no path is what the placeholder exists to save a lookup on.
    for (const file of [{ id: "9f1e" }, { path: "a.md" }, { id: "", path: "a.md" }, { id: "9f1e", path: 7 }, "a.md", []]) {
      expect(readWork({ work: [unit({}, { file })] }).kind, JSON.stringify(file)).toBe("unreadable");
    }
    // Explicitly null is not malformed — it is the event saying it names none.
    expect(readWork({ work: [unit({}, { file: null })] }).kind).toBe("work");
  });
});

describe("80-S14: an agent that already has a session running", () => {
  it("is not asked for work, and the refusal says why", () => {
    const { ask, held } = agentsToAsk(["dev-bot-mdden", "spec-warden"], new Set(["dev-bot-mdden"]));
    expect(ask).toEqual(["spec-warden"]);
    expect(held).toEqual([
      {
        agent: "dev-bot-mdden",
        reason: "dev-bot-mdden: a session is already running, so no second one is started. Its work waits for the next poll.",
      },
    ]);
  });

  it("is decided before the claim, so nothing is taken for it", () => {
    // The shape is the assertion: the function answers which agents to NAME in
    // the claim, and a name left out is a claim never made for it.
    const { ask } = agentsToAsk(["dev-bot-mdden"], new Set(["dev-bot-mdden"]));
    expect(ask).toEqual([]);
  });

  it("asks for everybody when nothing is running", () => {
    expect(agentsToAsk(["a", "b"], new Set())).toEqual({ ask: ["a", "b"], held: [] });
  });

  it("ignores a running session for an agent this machine no longer runs", () => {
    expect(agentsToAsk(["a"], new Set(["gone"]))).toEqual({ ask: ["a"], held: [] });
  });
});
