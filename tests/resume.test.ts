import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { claudeHarness, type Identity } from "../src/run/harness.ts";
import { diskInFlight, GUARD_MS, inFlightDir, inFlightPath, lockInFlight, lockIsStale, nameHarnessInLock, readHolding, readRecord, sweepGuards, UNNAMED_LOCK_MS, unlockInFlight, runningPid, writeInFlight, type InFlightRecord, type InFlightStore } from "../src/run/inflight.ts";
import { beingResumedMessage, HAZARD_LINE, leftBehindNote, NO_TERMINAL_MESSAGE, NOTHING_TO_RESUME, resumeRows, rowText, stateText, unfinishedMessage } from "../src/resume/rows.ts";
import { sessionPicker, type PickAnswer } from "../src/resume/screen.ts";
import { prepareResume, runResume, type ResumeDeps } from "../src/commands/resume.ts";
import { runAs, type AsDeps } from "../src/commands/as.ts";
import { mcpConfigPath } from "../src/config/store.ts";
import type { CommandContext } from "../src/cli.ts";
import type { AgentEntry, Config } from "../src/config/schema.ts";
import { COMMANDS } from "../src/main.ts";

// Parks one taker just before it creates a takeover's guard, so a race that
// needs microseconds in the wild can be laid out step by step.
const gate = vi.hoisted(() => ({ pid: 0, reached: () => {}, until: Promise.resolve(), noLinks: false, failRemove: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (gate.noLinks) throw Object.assign(new Error("operation not permitted, link"), { code: "EPERM" });
      if (gate.pid !== 0 && /\.lock\.[0-9a-fx]{16}$/.test(String(to)) && (await actual.readFile(from, "utf8")).includes(`"pid":${gate.pid},`)) {
        gate.pid = 0;
        gate.reached();
        await gate.until;
      }
      return actual.link(from, to);
    },
    rm: async (target: string, options?: Parameters<typeof actual.rm>[1]) => {
      if (gate.failRemove && String(target).endsWith(".json.lock")) {
        gate.failRemove = false;
        throw Object.assign(new Error("resource busy or locked, unlink"), { code: "EBUSY" });
      }
      return actual.rm(target, options);
    },
  };
});

const cwd = process.platform === "win32" ? "C:\\work\\checkout" : "/work/checkout";
const CLAIM = "3f2a0000-0000-4000-8000-000000000000";
const OTHER = "9c1d0000-0000-4000-8000-000000000000";
const NOW = new Date("2026-10-14T12:00:00.000Z");

const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  id: "agent-1",
  harness: "claude",
  pollsWork: true,
  cwd,
  env: { harness: "MY_KEY", connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" },
  limits: {},
  ...over,
});

const config = (agents: Record<string, AgentEntry> = { "dev-bot-mdden": entry(), "ux-critic": entry({ id: "agent-2" }) }): Config => ({
  version: 1,
  sessionsPerHour: null,
  agents,
});

const record = (over: Partial<InFlightRecord> = {}): InFlightRecord => ({
  claim: CLAIM,
  agentEntryId: "agent-1",
  agent: "dev-bot-mdden",
  workspace: "ws-1",
  brain: "markdown brain",
  cwd,
  startedAt: "2026-10-14T10:00:00.000Z",
  ownerPid: 111,
  harnessPid: 112,
  resumes: 0,
  ended: null,
  endedAt: null,
  ...over,
});

/** An in-memory store, with each operation in order and the locks it holds. */
function memoryStore(initial: InFlightRecord[] = [], locks = new Map<string, number>()) {
  const records = new Map(initial.map((r) => [r.claim, r]));
  const log: string[] = [];
  const store: InFlightStore = {
    write: async (r) => {
      records.set(r.claim, r);
      log.push(`write ${r.claim} owner ${r.ownerPid} harness ${r.harnessPid}`);
    },
    remove: async (claim) => {
      records.delete(claim);
      log.push(`remove ${claim}`);
    },
    list: async () => [...records.values()],
    lock: async (claim, pid, isAlive) => {
      const holder = locks.get(claim);
      if (holder !== undefined && holder !== pid && isAlive(holder)) return holder;
      locks.set(claim, pid);
      log.push(`lock ${claim}`);
      return null;
    },
    nameHarness: async (claim, harnessPid) => {
      log.push(`name ${claim} harness ${harnessPid}`);
    },
    unlock: async (claim) => {
      locks.delete(claim);
      log.push(`unlock ${claim}`);
    },
  };
  return { records, log, store, locks };
}

interface Started {
  command: string;
  args: string[];
  cwd: string;
}

function harness(over: Partial<ResumeDeps> = {}, initial: InFlightRecord[] = [record()]) {
  const memory = memoryStore(initial);
  const started: Started[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const picks: { claims: string[]; states: string[] }[] = [];
  const answers: PickAnswer[] = [];
  const context: CommandContext = { positional: [], flags: {}, out: (l) => lines.push(l), err: (l) => errors.push(l) };
  const deps: ResumeDeps = {
    env: { PATH: "/usr/bin", MY_KEY: "sk-live" },
    directoryExists: () => true,
    openKeyStore: () =>
      Promise.resolve({
        backend: { kind: "keychain", where: "the keychain" },
        get: () => Promise.resolve("smd_agent_deadbeef_secret"),
        set: () => Promise.resolve(),
        forget: () => Promise.resolve(),
      } as unknown as Awaited<ReturnType<AsDeps["openKeyStore"]>>),
    checkKey: () => Promise.resolve({ kind: "accepted", brains: ["markdown brain"] }),
    loadConfiguration: () => Promise.resolve({ kind: "config", config: config() }),
    inFlight: memory.store,
    isAlive: () => false,
    pid: 4410,
    now: () => NOW,
    startSession: ({ spawnable, cwd: at }) => {
      started.push({ command: spawnable.command, args: spawnable.args, cwd: at });
      return Promise.resolve({ exitCode: 0, signal: null, spawnProblem: null });
    },
    isTTY: true,
    pick: (rows) => {
      picks.push({ claims: rows.map((r) => r.record.claim), states: rows.map((r) => r.state.kind) });
      return Promise.resolve(answers.shift() ?? null);
    },
    ...over,
  };
  return { deps, context, memory, started, lines, errors, picks, answers };
}

describe("resume: the record on disk", () => {
  let root: string;
  let previous: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mdbrain-resume-state-"));
    previous = process.env.MDBRAIN_STATE_DIR;
    process.env.MDBRAIN_STATE_DIR = root;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.MDBRAIN_STATE_DIR;
    else process.env.MDBRAIN_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });

  it("163-S5: two sessions written at once are two files, each holding only its own record", async () => {
    await Promise.all([diskInFlight.write(record()), diskInFlight.write(record({ claim: OTHER, agent: "ux-critic", agentEntryId: "agent-2" }))]);
    expect(readdirSync(inFlightDir()).sort()).toEqual([`${CLAIM}.json`, `${OTHER}.json`]);
    expect(readRecord(JSON.parse(readFileSync(inFlightPath(CLAIM), "utf8")))).toEqual(record());
    expect(readRecord(JSON.parse(readFileSync(inFlightPath(OTHER), "utf8")))?.agent).toBe("ux-critic");
    expect((await diskInFlight.list()).map((r) => r.claim).sort()).toEqual([CLAIM, OTHER]);

    await diskInFlight.remove(CLAIM);
    expect(readdirSync(inFlightDir())).toEqual([`${OTHER}.json`]);
    // Removing what is already gone is not a failure.
    await expect(diskInFlight.remove(CLAIM)).resolves.toBeUndefined();
  });

  it("a claim that is not UUID-shaped is never made into a path", async () => {
    await expect(writeInFlight(record({ claim: "../../config" }))).rejects.toThrow(/not a session id/);
    expect(existsSync(inFlightDir()) ? readdirSync(inFlightDir()) : []).toEqual([]);
  });

  it("a file that does not read as a record, or is named for another claim, is skipped rather than offered", async () => {
    await diskInFlight.write(record());
    writeFileSync(join(inFlightDir(), `${OTHER}.json`), JSON.stringify(record()));
    writeFileSync(join(inFlightDir(), "9c1d0000-0000-4000-8000-00000000000a.json"), "{ not json");
    writeFileSync(join(inFlightDir(), "9c1d0000-0000-4000-8000-00000000000b.json"), JSON.stringify({ ...record(), ownerPid: "111" }));
    expect((await diskInFlight.list()).map((r) => r.claim)).toEqual([CLAIM]);
  });

  it("no directory at all is an empty list", async () => {
    expect(await diskInFlight.list()).toEqual([]);
  });
});

describe("resume: which sessions are offered, and as whom", () => {
  it("163-S7: a record whose entry id no configured agent has is drawn, and cannot be chosen", () => {
    const rows = resumeRows([record({ agentEntryId: "agent-gone", agent: "old-name" })], config(), () => false);
    expect(rows).toEqual([expect.objectContaining({ agent: null, state: { kind: "unconfigured" } })]);
    expect(rowText(rows[0], NOW.getTime(), 8)).toContain("old-name is no longer configured here");
  });

  it("the agent is read off the entry id, so a renamed agent still owns its session", () => {
    const rows = resumeRows([record({ agent: "dev-bot" })], config({ "dev-bot-mdden": entry() }), () => false);
    expect(rows[0].agent).toBe("dev-bot-mdden");
    expect(rows[0].state).toEqual({ kind: "resumable" });
  });

  it("163-S8: a record whose owner or harness is alive is running", () => {
    expect(runningPid(record(), (pid) => pid === 111)).toBe(111);
    expect(runningPid(record(), (pid) => pid === 112)).toBe(112);
    expect(runningPid(record({ harnessPid: null }), (pid) => pid === 112)).toBeNull();
    expect(runningPid(record(), () => false)).toBeNull();
  });

  it("163-S13: two agents' sessions are listed newest first, and a running one is marked", () => {
    const rows = resumeRows(
      [
        record({ claim: CLAIM, startedAt: "2026-10-13T12:00:00.000Z" }),
        record({ claim: OTHER, agentEntryId: "agent-2", agent: "ux-critic", startedAt: "2026-10-14T10:00:00.000Z", ownerPid: 222, harnessPid: null }),
      ],
      config(),
      (pid) => pid === 111,
    );
    expect(rows.map((r) => [r.agent, r.state.kind])).toEqual([
      ["ux-critic", "resumable"],
      ["dev-bot-mdden", "running"],
    ]);
    expect(rowText(rows[0], NOW.getTime(), 13)).toBe("ux-critic       claim 9c1d…   started 2h ago, never ended    markdown brain");
    expect(rowText(rows[1], NOW.getTime(), 13)).toContain("still running (process 111)");
  });
});

describe("resume: the picker", () => {
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
  };
  const DOWN = "\u001b[B";
  const ENTER = "\r";
  const rows = () =>
    resumeRows(
      [
        record({ claim: CLAIM, startedAt: "2026-10-14T11:00:00.000Z" }),
        record({ claim: OTHER, agentEntryId: "agent-2", agent: "ux-critic", startedAt: "2026-10-14T10:00:00.000Z", ownerPid: 222, harnessPid: null }),
      ],
      config(),
      (pid) => pid === 111,
    );

  it("163-S13: the running row cannot be chosen, the next one can, and the hazard is said under the list", async () => {
    const answers: PickAnswer[] = [];
    const { lastFrame, stdin } = render(sessionPicker(rows(), NOW.getTime(), (a) => answers.push(a)));
    await settle();
    expect(lastFrame() ?? "").toContain(HAZARD_LINE);
    stdin.write(ENTER);
    await settle();
    expect(answers).toEqual([]);
    expect(lastFrame() ?? "").toContain("That session is still running.");
    stdin.write(DOWN);
    await settle();
    stdin.write(ENTER);
    await settle();
    expect(answers).toEqual([{ kind: "resume", claim: OTHER }]);
  });

  it("163-S17: x asks first and y dismisses; any other key keeps it; a row that looks running is asked about more sharply", async () => {
    const answers: PickAnswer[] = [];
    const { lastFrame, stdin } = render(sessionPicker(rows(), NOW.getTime(), (a) => answers.push(a)));
    await settle();
    stdin.write("x");
    await settle();
    expect(lastFrame() ?? "").toContain("looks like it is still running");
    stdin.write("n");
    await settle();
    expect(answers).toEqual([]);
    stdin.write(DOWN);
    await settle();
    stdin.write("x");
    await settle();
    expect(lastFrame() ?? "").toContain("y to confirm");
    stdin.write("n");
    await settle();
    expect(answers).toEqual([]);
    stdin.write("x");
    await settle();
    stdin.write("y");
    await settle();
    expect(answers).toEqual([{ kind: "dismiss", claim: OTHER }]);
  });

  it("163-S7: enter on a row whose agent is gone resumes nothing", async () => {
    const answers: PickAnswer[] = [];
    const gone = resumeRows([record({ agentEntryId: "agent-gone" })], config(), () => false);
    const { lastFrame, stdin } = render(sessionPicker(gone, NOW.getTime(), (a) => answers.push(a)));
    await settle();
    stdin.write(ENTER);
    await settle();
    expect(answers).toEqual([]);
    expect(lastFrame() ?? "").toContain("no longer configured here");
  });
});

describe("resume: the command", () => {
  it("163-S9: the argv is the identity with --resume in place of --session-id, and nothing a triggered session adds", async () => {
    const { deps, context, started, answers } = harness();
    answers.push({ kind: "resume", claim: CLAIM });
    expect(await runResume(deps, context)).toBe(0);
    expect(started).toHaveLength(1);
    const args = started[0].args;

    const identity: Identity = {
      session: { kind: "new", id: CLAIM },
      agent: "dev-bot-mdden",
      mcpConfigPath: mcpConfigPath("dev-bot-mdden"),
      cwd,
      harnessCredential: "sk-live",
      connectionKeyVariable: "MDBRAIN_KEY_DEV_BOT_MDDEN",
      connectionKey: "smd_agent_deadbeef_secret",
      parentEnv: {},
    };
    const shared = claudeHarness.identityArgs(identity);
    const sessionAt = shared.indexOf("--session-id");
    // Every identity flag `as` carries, in order, with only the session flag
    // swapped, and the attended session's name after them, as `as` names it.
    expect(args).toEqual([...shared.slice(0, sessionAt), "--resume", CLAIM, "--name", "dev-bot-mdden-as"]);
    for (const absent of ["--session-id", "--fork-session", "-p", "--max-turns", "--max-budget-usd", "--permission-prompts", "--output-format"]) {
      expect(args).not.toContain(absent);
    }
    expect(started[0].cwd).toBe(cwd);
  });

  it("163-S8: a session still running is refused, and nothing is spawned", async () => {
    for (const alive of [111, 112]) {
      const { deps, context, started, errors, answers } = harness({ isAlive: (pid) => pid === alive });
      answers.push({ kind: "resume", claim: CLAIM });
      // The picker refuses it too; the command's own check is the rule.
      const prepared = await prepareResume(
        deps,
        { agent: "dev-bot-mdden", entry: entry(), claim: CLAIM, workspace: "ws-1", brain: null, cwd },
        (line) => errors.push(line),
      );
      expect(prepared).toBeNull();
      expect(errors).toEqual([`3f2a… is still running (process ${alive}).`]);
      expect(await runResume(deps, context)).toBe(1);
      expect(started).toEqual([]);
    }
  });

  it("163-S8: a record this process owns is not running, because this process is the one asking", async () => {
    const { deps, started, errors } = harness({ isAlive: () => true, pid: 111 }, [record({ harnessPid: null })]);
    const prepared = await prepareResume(deps, { agent: "dev-bot-mdden", entry: entry(), claim: CLAIM, workspace: "ws-1", brain: null, cwd }, (l) => errors.push(l));
    expect(prepared).not.toBeNull();
    expect(await prepared!.start()).toBe(0);
    expect(started).toHaveLength(1);
  });

  it("163-S22: two resumes of one claim cannot both start, however close together they are asked", async () => {
    const root = mkdtempSync(join(tmpdir(), "mdbrain-resume-state-"));
    const previous = process.env.MDBRAIN_STATE_DIR;
    process.env.MDBRAIN_STATE_DIR = root;
    try {
      await writeInFlight(record({ ownerPid: null, harnessPid: null }));
      const target = { agent: "dev-bot-mdden", entry: entry(), claim: CLAIM, workspace: "ws-1", brain: null, cwd };
      // Two processes, each alive to the other, both past the picker at once.
      const one = harness({ inFlight: diskInFlight, pid: 501, isAlive: (pid) => pid === 501 || pid === 502 });
      const two = harness({ inFlight: diskInFlight, pid: 502, isAlive: (pid) => pid === 501 || pid === 502 });
      const [first, second] = await Promise.all([
        prepareResume(one.deps, target, (l) => one.errors.push(l)),
        prepareResume(two.deps, target, (l) => two.errors.push(l)),
      ]);
      expect([first, second].filter((p) => p !== null)).toHaveLength(1);
      expect([...one.errors, ...two.errors]).toEqual([expect.stringMatching(/is being picked up by another mdbrain \(process 50[12]\)/)]);

      // The lock goes with the session, so the next resume can take it.
      await (first ?? second)!.start();
      const third = harness({ inFlight: diskInFlight, pid: 503 });
      const again = await prepareResume(third.deps, target, (l) => third.errors.push(l));
      expect(third.errors).toEqual([]);
      await again!.cancel();
    } finally {
      if (previous === undefined) delete process.env.MDBRAIN_STATE_DIR;
      else process.env.MDBRAIN_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A killed `run` leaves a record naming its own dead harness. Only the
  // holder's own record may stand in for an unnamed lock: read off any record,
  // that dead harness would make a resume's lock stale during its checks.
  it("163-S22: a resume still in its checks refuses a second one when the record names a killed run's harness", async () => {
    const root = mkdtempSync(join(tmpdir(), "mdbrain-resume-state-"));
    const previous = process.env.MDBRAIN_STATE_DIR;
    process.env.MDBRAIN_STATE_DIR = root;
    try {
      await writeInFlight(record({ ownerPid: 4000, harnessPid: 4001 }));
      const target = { agent: "dev-bot-mdden", entry: entry(), claim: CLAIM, workspace: "ws-1", brain: null, cwd };
      const one = harness({ inFlight: diskInFlight, pid: 501, isAlive: (pid) => pid === 501 || pid === 502 });
      const two = harness({ inFlight: diskInFlight, pid: 502, isAlive: (pid) => pid === 501 || pid === 502 });
      const first = await prepareResume(one.deps, target, (l) => one.errors.push(l));
      expect(first).not.toBeNull();
      expect(await prepareResume(two.deps, target, (l) => two.errors.push(l))).toBeNull();
      expect(two.errors).toEqual(["3f2a… is being picked up by another mdbrain (process 501)."]);
      await first!.cancel();
    } finally {
      if (previous === undefined) delete process.env.MDBRAIN_STATE_DIR;
      else process.env.MDBRAIN_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a lock left by a process that died is taken over", async () => {
    const root = mkdtempSync(join(tmpdir(), "mdbrain-resume-state-"));
    const previous = process.env.MDBRAIN_STATE_DIR;
    process.env.MDBRAIN_STATE_DIR = root;
    try {
      expect(await lockInFlight(CLAIM, 601, () => true)).toBeNull();
      expect(await lockInFlight(CLAIM, 602, (pid) => pid === 601)).toBe(601);
      expect(await lockInFlight(CLAIM, 602, () => false)).toBeNull();
      expect(readHolding(readFileSync(`${inFlightPath(CLAIM)}.lock`, "utf8"))?.pid).toBe(602);
      // A lock file is never listed as a session.
      expect(await diskInFlight.list()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MDBRAIN_STATE_DIR;
      else process.env.MDBRAIN_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("the lock a killed resume leaves", () => {
    let root: string;
    let previous: string | undefined;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "mdbrain-resume-state-"));
      previous = process.env.MDBRAIN_STATE_DIR;
      process.env.MDBRAIN_STATE_DIR = root;
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.MDBRAIN_STATE_DIR;
      else process.env.MDBRAIN_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    });

    const lockFile = () => `${inFlightPath(CLAIM)}.lock`;
    /** What a resume killed mid-session leaves: its record and its lock, both naming pid 5000, the lock naming harness 5001. */
    const killedMidSession = async () => {
      await writeInFlight(record({ ownerPid: 5000, harnessPid: 5001, resumes: 1 }));
      writeFileSync(lockFile(), JSON.stringify({ pid: 5000, token: "5".repeat(16), takenAt: Date.now(), harnessPid: 5001 }));
    };

    it("163-S26: once its pid is reused and its harness is gone, the session is dismissed after the confirmation", async () => {
      await killedMidSession();
      const { deps, context, answers, errors, lines } = harness({ inFlight: diskInFlight, isAlive: (pid) => pid === 5000 });
      answers.push({ kind: "dismiss", claim: CLAIM });
      expect(await runResume(deps, context)).toBe(0);
      expect(errors).toEqual([]);
      expect(lines).toEqual([NOTHING_TO_RESUME]);
      expect(existsSync(inFlightPath(CLAIM))).toBe(false);
      expect(existsSync(lockFile())).toBe(false);
    });

    it("163-S26: a resume of it is refused as still running, by the record, not as being picked up", async () => {
      await killedMidSession();
      const { deps, errors } = harness({ inFlight: diskInFlight, isAlive: (pid) => pid === 5000 });
      const prepared = await prepareResume(deps, { agent: "dev-bot-mdden", entry: entry(), claim: CLAIM, workspace: "ws-1", brain: null, cwd }, (l) => errors.push(l));
      expect(prepared).toBeNull();
      expect(errors).toEqual(["3f2a… is still running (process 5000)."]);
      expect(existsSync(lockFile())).toBe(false);
    });

    it("163-S26: while its owner and its harness are both alive the lock still holds, and nothing is dismissed", async () => {
      await killedMidSession();
      const { deps, context, answers, errors } = harness({ inFlight: diskInFlight, isAlive: (pid) => pid === 5000 || pid === 5001 });
      answers.push({ kind: "dismiss", claim: CLAIM });
      expect(await runResume(deps, context)).toBe(1);
      expect(errors).toEqual(["3f2a… is being picked up by another mdbrain (process 5000)."]);
      expect(existsSync(inFlightPath(CLAIM))).toBe(true);
    });

    it("163-S30: once its harness's pid is reused and its owner is gone, the session is dismissed after the confirmation", async () => {
      await killedMidSession();
      const { deps, context, answers, errors, lines } = harness({ inFlight: diskInFlight, isAlive: (pid) => pid === 5001 });
      answers.push({ kind: "dismiss", claim: CLAIM });
      expect(await runResume(deps, context)).toBe(0);
      expect(errors).toEqual([]);
      expect(lines).toEqual([NOTHING_TO_RESUME]);
      expect(existsSync(inFlightPath(CLAIM))).toBe(false);
      expect(existsSync(lockFile())).toBe(false);
    });

    it("163-S30: a harness that outlived its owner still refuses a resume, as still running by the record", async () => {
      await killedMidSession();
      const { deps, errors } = harness({ inFlight: diskInFlight, isAlive: (pid) => pid === 5001 });
      const prepared = await prepareResume(deps, { agent: "dev-bot-mdden", entry: entry(), claim: CLAIM, workspace: "ws-1", brain: null, cwd }, (l) => errors.push(l));
      expect(prepared).toBeNull();
      expect(errors).toEqual(["3f2a… is still running (process 5001)."]);
      expect(existsSync(inFlightPath(CLAIM))).toBe(true);
      expect(existsSync(lockFile())).toBe(false);
    });

    it("163-S30: a harness that outlived its owner keeps the lock when the record could not be told of it", async () => {
      await writeInFlight(record({ ownerPid: 5000, harnessPid: null, resumes: 1 }));
      writeFileSync(lockFile(), JSON.stringify({ pid: 5000, token: "5".repeat(16), takenAt: Date.now(), harnessPid: 5001 }));
      const { deps, errors } = harness({ inFlight: diskInFlight, isAlive: (pid) => pid === 5001 });
      const prepared = await prepareResume(deps, { agent: "dev-bot-mdden", entry: entry(), claim: CLAIM, workspace: "ws-1", brain: null, cwd }, (l) => errors.push(l));
      expect(prepared).toBeNull();
      expect(errors).toEqual(["3f2a… is being picked up by another mdbrain (process 5000)."]);
    });

    it("163-S30: a named lock holds while both its processes live, and is stale once either is gone", () => {
      const named = { pid: 601, token: "6".repeat(16), takenAt: 0, harnessPid: 777 };
      const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);
      const recorded = { ownerPid: 601, harnessPid: 777 };
      expect(lockIsStale(named, alive(601, 777), 0, recorded)).toBe(false);
      expect(lockIsStale(named, alive(601), 0, recorded)).toBe(true);
      expect(lockIsStale(named, alive(777), 0, recorded)).toBe(true);
      expect(lockIsStale(named, alive(), 0, recorded)).toBe(true);
    });

    it("163-S30: a lock whose naming failed is judged by the harness its holder's record names", () => {
      const unnamed = { pid: 601, token: "6".repeat(16), takenAt: 0, harnessPid: null };
      const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);
      const recorded = { ownerPid: 601, harnessPid: 777 };
      const later = 10 * UNNAMED_LOCK_MS;
      expect(lockIsStale(unnamed, alive(601, 777), later, recorded)).toBe(false);
      expect(lockIsStale(unnamed, alive(601), later, recorded)).toBe(true);
      expect(lockIsStale(unnamed, alive(777), later, recorded)).toBe(true);
    });

    it("163-S26: the harness a resume names is what its lock is judged by", async () => {
      expect(await lockInFlight(CLAIM, 601, () => true)).toBeNull();
      await nameHarnessInLock(CLAIM, 777);
      expect(readHolding(readFileSync(lockFile(), "utf8"))).toMatchObject({ pid: 601, harnessPid: 777 });
      expect(await lockInFlight(CLAIM, 602, (pid) => pid === 601 || pid === 777)).toBe(601);
      expect(await lockInFlight(CLAIM, 602, (pid) => pid === 601)).toBeNull();
    });

    it("163-S31: a lock file that does not parse is left to its writer for a moment, and taken over once it stays that way", async () => {
      mkdirSync(inFlightDir(), { recursive: true });
      writeFileSync(lockFile(), "");
      expect(await lockInFlight(CLAIM, 601, () => true)).toBe(0);
      expect(beingResumedMessage(CLAIM, 0)).toBe("3f2a… is being picked up by another mdbrain.");
      const past = new Date(Date.now() - GUARD_MS - 1_000);
      utimesSync(lockFile(), past, past);
      expect(await lockInFlight(CLAIM, 601, () => true)).toBeNull();
      expect(readHolding(readFileSync(lockFile(), "utf8"))?.pid).toBe(601);
    });

    it("163-S27: a lock that never named a harness holds for a preflight's length, and no longer", async () => {
      const t0 = Date.parse("2026-10-14T12:00:00.000Z");
      expect(await lockInFlight(CLAIM, 601, () => true, undefined, () => t0)).toBeNull();
      expect(await lockInFlight(CLAIM, 602, () => true, undefined, () => t0 + UNNAMED_LOCK_MS)).toBe(601);
      expect(await lockInFlight(CLAIM, 602, () => true, undefined, () => t0 + UNNAMED_LOCK_MS + 1)).toBeNull();
      expect(readHolding(readFileSync(lockFile(), "utf8"))?.pid).toBe(602);
    });

    it("163-S27: a lock whose holder has written the record as the session's owner is never aged, so a naming that failed cannot expire it", async () => {
      const t0 = Date.parse("2026-10-14T12:00:00.000Z");
      await writeInFlight(record({ ownerPid: 601, harnessPid: null }));
      expect(await lockInFlight(CLAIM, 601, () => true, undefined, () => t0)).toBeNull();
      expect(await lockInFlight(CLAIM, 602, () => true, undefined, () => t0 + 10 * UNNAMED_LOCK_MS)).toBe(601);
    });

    it("163-S28: two takers of one stale lock cannot both win it, even when one finishes before the other removes it", async () => {
      mkdirSync(inFlightDir(), { recursive: true });
      writeFileSync(lockFile(), JSON.stringify({ pid: 111, token: "1".repeat(16), takenAt: Date.now(), harnessPid: null }));
      const isAlive = (pid: number) => pid === 222 || pid === 333;
      let release = () => {};
      const parked = new Promise<void>((resolve) => {
        gate.reached = resolve;
      });
      gate.until = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate.pid = 333;
      // B reads the dead holder, then is parked before its takeover; A takes the whole lock meanwhile.
      const b = lockInFlight(CLAIM, 333, isAlive);
      await parked;
      expect(await lockInFlight(CLAIM, 222, isAlive)).toBeNull();
      release();
      expect(await b).toBe(222);
      expect(readHolding(readFileSync(lockFile(), "utf8"))?.pid).toBe(222);
      expect(readdirSync(inFlightDir()).sort()).toEqual([`${CLAIM}.json.lock`]);
    });

    it("163-S28: a guard left by a taker that died mid-takeover is swept once the lock is taken", async () => {
      mkdirSync(inFlightDir(), { recursive: true });
      const left = `${lockFile()}.${"7".repeat(16)}`;
      writeFileSync(left, JSON.stringify({ pid: 333, token: "3".repeat(16), takenAt: 0, harnessPid: null }));
      expect(await lockInFlight(CLAIM, 601, () => false)).toBeNull();
      expect(existsSync(left)).toBe(false);
      expect(readdirSync(inFlightDir())).toEqual([`${CLAIM}.json.lock`]);
    });

    it("163-S28: a sweep leaves the guard of a taker that is taking over this same lock", async () => {
      expect(await lockInFlight(CLAIM, 601, () => true)).toBeNull();
      const token = readHolding(readFileSync(lockFile(), "utf8"))!.token;
      const theirs = `${lockFile()}.${token}`;
      const left = `${lockFile()}.${"7".repeat(16)}`;
      writeFileSync(theirs, "{}");
      writeFileSync(left, "{}");
      await sweepGuards(lockFile(), token);
      expect(existsSync(theirs)).toBe(true);
      expect(existsSync(left)).toBe(false);
    });

    it("163-S22: a state root with no hard links still gets an exclusive lock", async () => {
      gate.noLinks = true;
      try {
        expect(await lockInFlight(CLAIM, 601, () => true)).toBeNull();
        expect(await lockInFlight(CLAIM, 602, () => true)).toBe(601);
        expect(readHolding(readFileSync(lockFile(), "utf8"))?.pid).toBe(601);
      } finally {
        gate.noLinks = false;
      }
    });

    it("163-S29: letting a lock go leaves one somebody else has taken since", async () => {
      expect(await lockInFlight(CLAIM, 601, () => true)).toBeNull();
      const theirs = JSON.stringify({ pid: 602, token: "6".repeat(16), takenAt: Date.now(), harnessPid: null });
      writeFileSync(lockFile(), theirs);
      await unlockInFlight(CLAIM);
      expect(readFileSync(lockFile(), "utf8")).toBe(theirs);
    });

    it("163-S29: naming a harness leaves a lock somebody else has taken since", async () => {
      expect(await lockInFlight(CLAIM, 601, () => true)).toBeNull();
      const theirs = JSON.stringify({ pid: 602, token: "6".repeat(16), takenAt: Date.now(), harnessPid: null });
      writeFileSync(lockFile(), theirs);
      await nameHarnessInLock(CLAIM, 777);
      expect(readFileSync(lockFile(), "utf8")).toBe(theirs);
    });

    it("163-S29: a lock this process failed to let go is taken again by this same process, not refused by its own pid", async () => {
      expect(await lockInFlight(CLAIM, 601, () => true)).toBeNull();
      gate.failRemove = true;
      await expect(unlockInFlight(CLAIM)).rejects.toThrow(/busy/);
      expect(readHolding(readFileSync(lockFile(), "utf8"))?.pid).toBe(601);
      expect(await lockInFlight(CLAIM, 601, () => true)).toBeNull();
      expect(await lockInFlight(CLAIM, 602, () => true)).toBe(601);
      await unlockInFlight(CLAIM);
    });
  });

  it("163-S23: the resume runs where the session ran, and a directory that is gone is refused in a sentence", async () => {
    const moved = harness({ loadConfiguration: () => Promise.resolve({ kind: "config", config: config({ "dev-bot-mdden": entry({ cwd: "/somewhere/new" }) }) }) });
    moved.answers.push({ kind: "resume", claim: CLAIM });
    expect(await runResume(moved.deps, moved.context)).toBe(0);
    expect(moved.started[0].cwd).toBe(cwd);

    const gone = harness({ directoryExists: (path) => path !== cwd, loadConfiguration: () => Promise.resolve({ kind: "config", config: config({ "dev-bot-mdden": entry({ cwd: "/somewhere/new" }) }) }) });
    gone.answers.push({ kind: "resume", claim: CLAIM });
    expect(await runResume(gone.deps, gone.context)).toBe(1);
    expect(gone.started).toEqual([]);
    expect(gone.errors).toEqual([`3f2a… ran in ${cwd}, which is gone, and its conversation is filed under that directory.`]);
    expect(gone.memory.locks.size).toBe(0);
  });

  it("the harness's pid is recorded, and named in the lock, once it has started, so a resume whose owner is killed still reads as running", async () => {
    const { deps, context, memory, answers } = harness({
      startSession: (request) => {
        request.onSpawned?.(7777);
        return Promise.resolve({ exitCode: 0, signal: null, spawnProblem: null });
      },
    });
    answers.push({ kind: "resume", claim: CLAIM });
    expect(await runResume(deps, context)).toBe(0);
    expect(memory.log).toEqual([
      `lock ${CLAIM}`,
      `write ${CLAIM} owner 4410 harness null`,
      `name ${CLAIM} harness 7777`,
      `write ${CLAIM} owner 4410 harness 7777`,
      `remove ${CLAIM}`,
      `unlock ${CLAIM}`,
    ]);
  });

  it("163-S10: every refusal `as` has is the same sentence for a resume of the same entry", async () => {
    const cases: Partial<ResumeDeps>[] = [
      { directoryExists: () => false },
      { env: { PATH: "/usr/bin" } },
      { openKeyStore: () => Promise.reject(new Error("no keychain")) },
      {
        openKeyStore: () =>
          Promise.resolve({
            backend: { kind: "keychain", where: "the keychain" },
            get: () => Promise.resolve(null),
          } as unknown as Awaited<ReturnType<AsDeps["openKeyStore"]>>),
      },
      {
        openKeyStore: () =>
          Promise.resolve({
            backend: { kind: "keychain", where: "the keychain" },
            get: () => Promise.reject(new Error("locked")),
          } as unknown as Awaited<ReturnType<AsDeps["openKeyStore"]>>),
      },
      { checkKey: () => Promise.resolve({ kind: "refused", status: 401 } as never) },
      { loadConfiguration: () => Promise.resolve({ kind: "config", config: config({ "dev-bot-mdden": entry({ env: { harness: "MY_KEY", connectionKey: "ANTHROPIC_API_KEY" } }) }) }) },
    ];
    for (const over of cases) {
      const resumed = harness(over);
      resumed.answers.push({ kind: "resume", claim: CLAIM });
      expect(await runResume(resumed.deps, resumed.context)).toBe(1);
      expect(resumed.started).toEqual([]);

      const asErrors: string[] = [];
      const asDeps: AsDeps = {
        env: resumed.deps.env,
        directoryExists: resumed.deps.directoryExists,
        openKeyStore: resumed.deps.openKeyStore,
        checkKey: resumed.deps.checkKey,
        loadConfiguration: resumed.deps.loadConfiguration,
        startSession: () => Promise.resolve({ exitCode: 0, signal: null, spawnProblem: null }),
        isTTY: false,
        pickAgent: () => Promise.resolve(null),
        newSessionId: () => OTHER,
      };
      expect(await runAs(asDeps, { positional: ["dev-bot-mdden"], flags: {}, out: () => {}, err: (l) => asErrors.push(l) })).toBe(1);
      expect(asErrors.length).toBe(1);
      expect(resumed.errors).toEqual(asErrors);
    }
  });

  it("163-S11: a resume that completes leaves the run log byte-identical, makes no claim, and removes its record", async () => {
    const root = mkdtempSync(join(tmpdir(), "mdbrain-resume-state-"));
    const previous = process.env.MDBRAIN_STATE_DIR;
    process.env.MDBRAIN_STATE_DIR = root;
    try {
      const row = `${JSON.stringify({ claim: CLAIM, agent: "dev-bot-mdden", outcome: "failed" })}\n`;
      writeFileSync(join(root, "runs.jsonl"), row);
      await writeInFlight(record());
      const { deps, context, started, answers } = harness({ inFlight: diskInFlight });
      answers.push({ kind: "resume", claim: CLAIM });
      // The command has no claim to make: nothing that could reach the server's
      // work stream, or the person's login it would need, is among what it is handed.
      expect(Object.keys(deps).filter((name) => /claim|count|^session$|roster/i.test(name))).toEqual([]);
      expect(await runResume(deps, context)).toBe(0);
      expect(started).toHaveLength(1);
      expect(readFileSync(join(root, "runs.jsonl"), "utf8")).toBe(row);
      expect(readdirSync(inFlightDir())).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.MDBRAIN_STATE_DIR;
      else process.env.MDBRAIN_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("163-S12: a resume that ends on a signal or a non-zero code keeps its record, counted, and says so", async () => {
    for (const ending of [
      { exitCode: null, signal: "SIGTERM" as NodeJS.Signals, spawnProblem: null },
      { exitCode: 2, signal: null, spawnProblem: null },
    ]) {
      const { deps, context, memory, errors, answers } = harness({ startSession: () => Promise.resolve(ending) });
      answers.push({ kind: "resume", claim: CLAIM });
      expect(await runResume(deps, context)).toBe(ending.exitCode ?? 1);
      // Owned by nothing now, so no other process reads it as still running —
      // which matters most for a resume a long-lived runner's view started.
      expect(memory.records.get(CLAIM)).toEqual(
        expect.objectContaining({ resumes: 1, ownerPid: null, harnessPid: null, startedAt: NOW.toISOString(), agentEntryId: "agent-1" }),
      );
      expect(memory.locks.size).toBe(0);
      expect(errors.at(-1)).toBe(unfinishedMessage(CLAIM));
      if (ending.signal !== null) expect(errors).toContain("The session ended on SIGTERM rather than exiting.");
    }
  });

  it("163-S15: with nobody at the terminal every session is printed, the terminal is named, and the exit code is 1", async () => {
    const { deps, context, lines, errors, picks } = harness({ isTTY: false }, [
      record(),
      record({ claim: OTHER, agentEntryId: "agent-2", agent: "ux-critic", startedAt: "2026-10-14T11:00:00.000Z" }),
    ]);
    expect(await runResume(deps, context)).toBe(1);
    expect(picks).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ux-critic");
    expect(lines[1]).toContain("dev-bot-mdden");
    expect(errors).toEqual([NO_TERMINAL_MESSAGE]);
  });

  it("an empty list says so and exits 0, at a terminal or not", async () => {
    for (const isTTY of [true, false]) {
      const { deps, context, lines, picks } = harness({ isTTY }, []);
      expect(await runResume(deps, context)).toBe(0);
      expect(lines).toEqual([NOTHING_TO_RESUME]);
      expect(picks).toEqual([]);
    }
  });

  it("163-S17: a dismissal removes the record and draws the list again from disk; leaving says nothing and exits 1", async () => {
    const { deps, context, memory, picks, answers, errors, started } = harness({}, [
      record(),
      record({ claim: OTHER, agentEntryId: "agent-2", agent: "ux-critic" }),
    ]);
    answers.push({ kind: "dismiss", claim: CLAIM }, null);
    expect(await runResume(deps, context)).toBe(1);
    expect(memory.log).toEqual([`lock ${CLAIM}`, `remove ${CLAIM}`, `unlock ${CLAIM}`]);
    expect(picks.map((p) => p.claims)).toEqual([[CLAIM, OTHER], [OTHER]]);
    expect(errors).toEqual([]);
    expect(started).toEqual([]);
  });

  it("163-S17: a session another mdbrain is resuming is not dismissed, read at the moment of the dismissal", async () => {
    // The list was drawn before the other window began; only the lock knows.
    const { deps, context, memory, answers, errors } = harness({ isAlive: (pid) => pid === 9001 }, [record({ ownerPid: null, harnessPid: null })]);
    memory.locks.set(CLAIM, 9001);
    answers.push({ kind: "dismiss", claim: CLAIM });
    expect(await runResume(deps, context)).toBe(1);
    expect(memory.records.has(CLAIM)).toBe(true);
    expect(errors).toEqual(["3f2a… is being picked up by another mdbrain (process 9001)."]);
  });

  it("163-S17: a session that only looks running, by a pid that may have been reused, is dismissed once confirmed", async () => {
    const { deps, context, memory, answers } = harness({ isAlive: (pid) => pid === 111 });
    answers.push({ kind: "dismiss", claim: CLAIM }, null);
    expect(await runResume(deps, context)).toBe(0);
    expect(memory.records.has(CLAIM)).toBe(false);
  });

  it("is registered, and needs no flag to be useful", () => {
    const command = COMMANDS.find((c) => c.name === "resume");
    expect(command?.summary).toMatch(/run session/);
    expect(command?.flags ?? []).toEqual([]);
  });
});

describe("resume: a session kept after its runner has gone", () => {
  const stopped = (over: Partial<InFlightRecord> = {}) =>
    record({ ownerPid: null, harnessPid: null, ended: "stopped", endedAt: "2026-10-14T10:00:00.000Z", startedAt: "2026-10-14T09:00:00.000Z", ...over });

  it("176-S5: a record with no ending still reads, as one that never ended", () => {
    const { ended: _ended, endedAt: _endedAt, ...older } = record();
    expect(readRecord(older)).toEqual(expect.objectContaining({ claim: CLAIM, ended: null, endedAt: null }));
    // An ending this build does not know is read the same way, rather than losing the session.
    expect(readRecord({ ...older, ended: "evaporated", endedAt: "2026-10-14T10:00:00.000Z" })).toEqual(expect.objectContaining({ ended: null, endedAt: null }));
    expect(readRecord(stopped())).toEqual(expect.objectContaining({ ended: "stopped", endedAt: "2026-10-14T10:00:00.000Z" }));
    // An ending with no date it could be aged from is no ending a row can say.
    expect(readRecord({ ...older, ended: "stopped", endedAt: "x" })).toEqual(expect.objectContaining({ ended: null, endedAt: null }));
  });

  it("176-S6: the picker says how a kept session ended, aged from its ending, and a record with no ending still reads never ended", () => {
    const rows = resumeRows(
      [stopped(), stopped({ claim: OTHER, ended: "failed" }), record({ claim: "77e00000-0000-4000-8000-000000000000", ownerPid: null, harnessPid: null })],
      config(),
      () => false,
    );
    const text = Object.fromEntries(rows.map((row) => [row.record.claim, stateText(row, NOW.getTime())]));
    expect(text[CLAIM]).toBe("stopped 2h ago, when the runner stopped");
    expect(text[OTHER]).toBe("failed 2h ago");
    expect(text["77e00000-0000-4000-8000-000000000000"]).toBe("started 2h ago, never ended");
    // A resume is the newer fact than the ending it came from, and it is the one that did not end.
    expect(stateText(resumeRows([stopped({ resumes: 1, startedAt: "2026-10-14T11:00:00.000Z" })], config(), () => false)[0], NOW.getTime())).toBe(
      "resumed 1h ago, never ended",
    );
    for (const [ended, said] of [["timed-out", "timed out 2h ago"], ["unreadable", "unreadable 2h ago"], ["killed", "killed 2h ago"]] as const) {
      expect(stateText(resumeRows([stopped({ ended })], config(), () => false)[0], NOW.getTime())).toBe(said);
    }
  });

  it("176-S7: the next run's note says a session was stopped with the runner, and keeps today's sentence for one with no ending", () => {
    expect(leftBehindNote([stopped()], () => false)).toBe("dev-bot-mdden's session 3f2a… was stopped with the runner. `mdbrain resume` can pick it up.");
    expect(leftBehindNote([record({ ownerPid: 999 })], () => false)).toBe("dev-bot-mdden's session 3f2a… started and never ended. `mdbrain resume` can pick it up.");
    expect(leftBehindNote([stopped(), stopped({ claim: OTHER, agentEntryId: "agent-2", agent: "ux-critic", ended: "failed" })], () => false)).toBe(
      "2 sessions were cut short (dev-bot-mdden, ux-critic). `mdbrain resume` can pick them up.",
    );
    expect(leftBehindNote([stopped(), record({ claim: OTHER, ownerPid: 999 })], () => false)).toContain("2 sessions were cut short or never ended");
    // A kept session a person resumed since, whose resume died, is said as the resume, as the picker says it.
    expect(leftBehindNote([stopped({ resumes: 1 })], () => false)).toBe("dev-bot-mdden's session 3f2a… was resumed and never ended. `mdbrain resume` can pick it up.");
    expect(leftBehindNote([stopped({ resumes: 1 }), stopped({ claim: OTHER })], () => false)).toContain("2 sessions were cut short or never ended");
  });

  it("176-S8: a session stopped with its runner is listed by mdbrain resume and resumed through prepareResume", async () => {
    const { deps, context, picks, started, answers, memory } = harness({}, [stopped()]);
    answers.push({ kind: "resume", claim: CLAIM });
    expect(await runResume(deps, context)).toBe(0);
    expect(picks[0]).toEqual({ claims: [CLAIM], states: ["resumable"] });
    expect(started).toHaveLength(1);
    expect(started[0].args).toEqual(expect.arrayContaining(["--resume", CLAIM]));
    expect(memory.log).toEqual(expect.arrayContaining([`lock ${CLAIM}`, `remove ${CLAIM}`]));
  });

  it("a resume of a kept session that fails keeps the ending it came with", async () => {
    const { deps, context, memory, answers } = harness({ startSession: () => Promise.resolve({ exitCode: 2, signal: null, spawnProblem: null }) }, [stopped()]);
    answers.push({ kind: "resume", claim: CLAIM });
    await runResume(deps, context);
    expect(memory.records.get(CLAIM)).toEqual(expect.objectContaining({ resumes: 1, ownerPid: null, ended: "stopped", endedAt: "2026-10-14T10:00:00.000Z" }));
  });
});
