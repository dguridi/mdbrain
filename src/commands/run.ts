// `mdbrain run` — poll for the configured agents' work, and start one harness
// session for each unit of it.
//
// The command a person leaves running. That one fact decides three things here:
// **it never opens a browser** (a login on a machine nobody is watching is not a
// login, so a missing session is a refusal naming `mdbrain login`); **it holds
// rather than exits** when one agent cannot run, since the others still can; and
// **it says what it is doing continuously**, because a silent long-running
// process is indistinguishable from a stopped one.
//
// This file is the order and the impure edges: the timer, the session set, the
// queues, and the two presenters. Every decision it makes is somewhere else —
// `run/loop.ts` for who to ask and where work goes, `run/harness.ts` for what to
// spawn, `run/outcome.ts` for what a result means, `work/instruction.ts` for what
// the claim answered. That is what lets the whole of `run` be tested without a
// process, a socket or a terminal.
//
// **Nothing here writes to a stream directly once the presenter exists.** Every
// line after startup is an event, so the plain lines and the live view are two
// renderings of one set of facts rather than two accounts of them. The startup
// refusals below are the exception and are deliberately before any presenter: a
// `run` that cannot start has nothing to present.
//
// **A presenter can also ask, and this is the only place that answers.** A key
// pressed in the live view arrives here as a `ViewRequest` — *poll now*, *stop*
// — and what happens about it is decided in this file, beside the timer and the
// signals, exactly where the decision about a poll already lived. The presenter
// forwards a request and starts nothing itself, which is the same rule as
// before said in the one direction it had never had to be said in.

import { existsSync } from "node:fs";
import type { CommandContext, CommandSpec } from "../cli.ts";
import { askForCount, AuthError, claimWork, listAgents } from "../auth/api.ts";
import { signInAgainMessage } from "../auth/session.ts";
import { durationMs, type AgentEntry, type Config } from "../config/schema.ts";
import { loadConfig, mcpConfigPath } from "../config/store.ts";
import { configPath } from "../config/paths.ts";
import { keyStorageLine, openConnectionKeyStore, type ConnectionKeyStore } from "../config/secrets.ts";
import { readWork, type WorkUnit } from "../work/instruction.ts";
import { answerPollNow, CLAIM_LIMIT, placeWork, planStartup, renamedAgents, summaryLines, tickPlan } from "../run/loop.ts";
import { credentialsCollide, harnessFor } from "../run/harness.ts";
import { runSession, type StopRegistry } from "../run/execute.ts";
import { readOutcome, type Outcome } from "../run/outcome.ts";
import { renderPrompt } from "../run/prompt.ts";
import { appendRun, logRow, runLogPath } from "../run/log.ts";
import { plainPresenter, type Presenter, type RunEvent } from "../run/present.ts";
import { livePresenter } from "../run/screen.ts";
import type { ViewRequest } from "../run/keys.ts";
import { readySession } from "./session.ts";

/**
 * What the command needs from outside itself, so a test can stand each one in.
 *
 * Every edge is here — the disk, the session, the three network calls, the
 * process, the clock and the terminal — because the value of this command is
 * entirely in its *order*, and an order that can only be exercised against a
 * real stack is one nobody exercises.
 */
export interface RunDeps {
  /** Whether a person is watching, which is the whole of the presenter choice. */
  isTTY: boolean;
  env: Record<string, string | undefined>;
  directoryExists: (path: string) => boolean;
  openKeyStore: () => Promise<ConnectionKeyStore>;
  loadConfiguration: typeof loadConfig;
  session: typeof readySession;
  roster: typeof listAgents;
  count: typeof askForCount;
  claim: typeof claimWork;
  /** Starts one harness session and answers what it left behind. */
  startSession: typeof runSession;
  /** Appends one row to the run log. */
  recordRun: typeof appendRun;
  /** Waits, or resolves at once when something asks the loop to stop. */
  sleep: (ms: number, signal: { stopped: boolean; wake: (() => void) | null }) => Promise<void>;
  now: () => Date;
}

/** The sentences that end `run` before it has started. */
export function noConfigMessage(path: string): string {
  return `Nothing is configured; run \`mdbrain configure\`. The file would be at ${path}.`;
}
export const UNREADABLE_CONFIG_MESSAGE =
  "The configuration is there but could not be read. Check that it is readable, or run `mdbrain configure` again.";
export const ALL_HELD_MESSAGE =
  "Every configured agent is held, so there is nobody to ask for work. The lines above say why for each.";

/** The default sleeper: a timer that can be cut short by a stop. */
export function waitFor(ms: number, signal: { stopped: boolean; wake: (() => void) | null }): Promise<void> {
  if (signal.stopped) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.wake = finish;
    function finish() {
      clearTimeout(timer);
      signal.wake = null;
      resolve();
    }
  });
}

const defaultDeps: RunDeps = {
  isTTY: process.stdout.isTTY === true,
  env: process.env,
  directoryExists: (path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  },
  openKeyStore: () => openConnectionKeyStore(),
  loadConfiguration: loadConfig,
  session: readySession,
  roster: listAgents,
  count: askForCount,
  claim: claimWork,
  startSession: runSession,
  recordRun: appendRun,
  sleep: waitFor,
  now: () => new Date(),
};

/** One agent's live state: what is running for it, and what is waiting. */
interface AgentWork {
  running: boolean;
  queue: WorkUnit[];
}

/**
 * The command, with its dependencies handed in.
 *
 * The order is §5a's and each step's failure is one sentence and exit 1:
 * configuration, session, environment, roster, summary — and only then the loop.
 */
export async function runRun(deps: RunDeps, context: CommandContext): Promise<number> {
  const { out, err } = context;
  const once = context.flags.once === true;

  const loaded = await deps.loadConfiguration();
  if (loaded.kind === "none") {
    err(noConfigMessage(configPath()));
    return 1;
  }
  if (loaded.kind === "unreadable") {
    err(UNREADABLE_CONFIG_MESSAGE);
    return 1;
  }
  if (loaded.kind === "problem") {
    err(loaded.message);
    return 1;
  }
  const config = loaded.config;

  // Read once here so a signed-out runner refuses before it draws anything;
  // the tick reads it again each poll for the token, which is where a session
  // that ends mid-run is caught.
  const session = await deps.session();
  if (session.kind === "stop") {
    // Deliberately no inline login, unlike `configure`: this is the command a
    // service manager starts, and a browser opening on a machine nobody is
    // watching is not a login.
    err(session.message);
    return 1;
  }

  // The roster is read once. A change while running is picked up by a restart,
  // which is what a `configure` ends in anyway — and polling it would be a
  // second network call per tick to answer a question that almost never changes.
  let rosterNames: Set<string> | null = null;
  let rosterById = new Map<string, string>();
  try {
    const agents = await deps.roster(session.accessToken);
    rosterNames = new Set(agents.map((a) => a.display_name));
    rosterById = new Map(agents.map((a) => [a.display_name, a.id]));
  } catch (cause) {
    const refused = cause instanceof AuthError ? signInAgainMessage(cause.status) : null;
    if (refused) {
      err(`${refused} (the server said: ${(cause as Error).message})`);
      return 1;
    }
    // Unreachable is not a reason to refuse to start: the poll will fail and say
    // so, and a runner that would not start because the roster read timed out is
    // a runner that needs a person present to survive a network blip.
    err(`Could not read the roster: ${(cause as Error).message}. Starting anyway; a configured name that no longer exists will simply receive no work.`);
  }

  const startup = planStartup(config, deps.env, deps.directoryExists, rosterNames);

  let keyStore: ConnectionKeyStore;
  try {
    keyStore = await deps.openKeyStore();
  } catch (cause) {
    err(`Could not open the connection key store: ${(cause as Error).message}`);
    return 1;
  }

  const presenter: Presenter = deps.isTTY ? livePresenter(out, deps.now) : plainPresenter(out, deps.now);
  const say = (event: RunEvent) => presenter.present(event, deps.now());

  for (const agent of startup.asking) say({ kind: "configured", agent });
  for (const held of startup.held) say({ kind: "held", agent: held.agent, reason: held.reason });
  for (const renamed of renamedAgents(config, rosterById)) {
    say({
      kind: "note",
      message: `${renamed.configuredAs} is now called ${renamed.nowCalled} in the roster. Run \`mdbrain configure\` so the two agree; until then it will receive no work.`,
    });
  }
  say({ kind: "summary", lines: summaryLines(startup, config, runLogPath(), keyStorageLine(keyStore.backend)) });

  if (startup.asking.length === 0) {
    await presenter.stop();
    err(ALL_HELD_MESSAGE);
    return 1;
  }

  const work = new Map<string, AgentWork>();
  for (const agent of startup.asking) work.set(agent, { running: false, queue: [] });
  const busy = () => new Set([...work].filter(([, w]) => w.running).map(([agent]) => agent));
  const depths = () => new Map([...work].map(([agent, w]) => [agent, w.queue.length]));

  const stop = { stopped: false, wake: null as (() => void) | null };
  /** Whether a tick is in flight, which is what a second poll would collide with. */
  let polling = false;
  /** When a poll a person asked for was last taken, for the minimum spacing. */
  let lastAskedAt: number | null = null;
  /**
   * Whether the loop will poll again, said once and never taken back.
   *
   * **`run` spends real time in a state where no poll is coming**, and it is not
   * a moment: `--once` waits out the sessions its single tick started, a session
   * the server has ended leaves the loop the same way, and a stop waits each
   * running session out to its grace period. All three can run for minutes with
   * the view still on screen. Without this the countdown would count down to a
   * poll that never comes, and a key pressed then would be reported as taken and
   * do nothing at all.
   */
  let finishing = false;

  /**
   * A poll a person asked for that the loop has not acted on yet.
   *
   * **The wake is the fast path and this is the guarantee.** Waking the sleeper
   * is what cuts a wait short, and it is enough today: nothing awaits between a
   * tick ending and the next wait beginning, so a keypress — which arrives on an
   * I/O callback — cannot land in that gap with no wait to cut short. But that
   * is a property of where the awaits currently are rather than of the design,
   * and the failure it protects against is a bad one: a request reported as
   * taken that silently does nothing for a whole interval. So the loop is told
   * to skip the wait it was about to start, and the promise *a taken request
   * causes a poll* stops resting on an argument about scheduling.
   */
  let pollAsked = false;
  const sessions = new Set<Promise<void>>();
  // Every running session registers here. **Ctrl-C does not reach them on its
  // own**: each child is spawned into its own process group so that killing it
  // reaches the tools it started, and the price of that is that the terminal's
  // signal never arrives. Without this the runner would exit while its harness
  // sessions carried on with no terminal and nobody watching.
  const stoppers = new Set<() => void>();
  const onSessionStop: StopRegistry = (stopper) => {
    stoppers.add(stopper);
    return () => stoppers.delete(stopper);
  };
  let anyFailed = false;

  /**
   * Run one unit to its end, then start whatever was waiting behind it.
   *
   * Recursive on purpose rather than a loop: *the next unit starts when this one
   * ends* is the whole of the queue's behaviour, and expressing it here keeps the
   * agent's `running` flag and the queue in step without a second place that
   * clears it.
   */
  const startUnit = async (agent: string, entry: AgentEntry, unit: WorkUnit): Promise<void> => {
    const state = work.get(agent)!;
    state.running = true;
    say({
      kind: "start",
      agent,
      claim: unit.instruction.claim,
      unitKind: unit.kind,
      seq: unit.seq,
      workspace: unit.instruction.workspace,
    });

    const startedAt = deps.now();
    const outcome = await oneSession(deps, keyStore, entry, unit, onSessionStop);
    const endedAt = deps.now();
    const elapsed = endedAt.getTime() - startedAt.getTime();

    try {
      await deps.recordRun(logRow(unit, outcome, startedAt, endedAt));
    } catch (cause) {
      // The work happened. Losing the record of it is smaller than reporting an
      // outcome that did not occur, so this is a note rather than a failure.
      say({ kind: "note", message: `The run log could not be written: ${(cause as Error).message}` });
    }

    if (outcome.kind === "done" || outcome.kind === "stopped") {
      say({
        kind: "done",
        agent,
        claim: unit.instruction.claim,
        ms: elapsed,
        costUsd: outcome.costUsd,
        turns: outcome.turns,
        message: outcome.message,
      });
    } else {
      anyFailed = true;
      say({ kind: "failed", agent, claim: unit.instruction.claim, outcome: outcome.kind, ms: elapsed, message: outcome.message });
    }

    state.running = false;
    // No retry, on any outcome. The claim is already spent, and a second attempt
    // would be a promise the layer above cannot honour.
    const next = state.queue.shift();
    if (next && !stop.stopped) await startUnit(agent, entry, next);
  };

  /** Set when the session is over, which is the one thing that ends the loop early. */
  let sessionEnded: string | null = null;

  /**
   * Whether a failed call means the session is gone rather than the network is.
   *
   * The distinction is the difference between one line and the end of the run: a
   * request that never got a verdict is tried again next poll, while a server
   * that refused the token will refuse every later tick for the same reason. A
   * revocation reported as a network blip is the worst of the two mistakes —
   * the runner would poll for days printing *could not be read* and starting
   * nothing, and exit 0 when finally stopped.
   */
  const refusal = (cause: unknown): string | null =>
    cause instanceof AuthError ? signInAgainMessage(cause.status) : null;

  const tick = async (): Promise<void> => {
    const plan = tickPlan(startup.asking, busy());
    for (const skipped of plan.skipped) say({ kind: "skipped", agent: skipped.agent, reason: skipped.reason });
    if (plan.ask.length === 0) return;

    // **The token is produced per tick, not held from startup.** An access token
    // lasts about an hour and this is the command a person leaves running for
    // days, so a token captured once turns into a runner that polls forever and
    // starts nothing. This is not the background refresh timer spec 96 forbids:
    // it is the same read-refresh-write every command does, done before each
    // poll rather than on a clock of its own, and a session that is genuinely
    // over ends the run here rather than being retried.
    const ready = await deps.session();
    if (ready.kind === "stop") {
      sessionEnded = ready.message;
      return;
    }
    const token = ready.accessToken;

    let waiting: number;
    try {
      const counted = await deps.count(token, plan.ask);
      waiting = counted.waiting;
    } catch (cause) {
      const refused = refusal(cause);
      if (refused) {
        sessionEnded = refused;
        return;
      }
      say({ kind: "note", message: `The count could not be read: ${(cause as Error).message}` });
      return;
    }
    say({ kind: "poll", agents: plan.ask, waiting });
    // The cheap gate: nothing waiting is the common answer, and it costs one
    // read rather than a write.
    if (waiting === 0) return;

    let body: unknown;
    try {
      body = await deps.claim(token, plan.ask, CLAIM_LIMIT, config.sessionsPerHour);
    } catch (cause) {
      const refused = refusal(cause);
      if (refused) {
        sessionEnded = refused;
        return;
      }
      say({ kind: "note", message: `The claim failed: ${(cause as Error).message}` });
      return;
    }

    const reading = readWork(body);
    if (reading.kind === "unreadable") {
      say({ kind: "note", message: reading.message });
      return;
    }
    for (const refusal of reading.refused) say({ kind: "refused", agent: refusal.agent, reason: refusal.reason });

    for (const placement of placeWork(reading.work, busy(), depths())) {
      const agent = placement.unit.instruction.agent;
      const entry = config.agents[agent];
      const state = work.get(agent);
      if (!entry || !state) {
        // Work for an agent this runner is not running. The server matched a
        // name this process holds, so this is a rename mid-flight rather than a
        // mistake — said out loud, because the unit is spent either way.
        say({ kind: "note", message: `Work arrived for ${agent}, which this runner is not running; it is spent and was not started.` });
        continue;
      }
      if (placement.action === "queue") {
        state.queue.push(placement.unit);
        say({ kind: "queued", agent, depth: placement.depth });
        continue;
      }
      const running = startUnit(agent, entry, placement.unit);
      sessions.add(running);
      // The derived promise needs its own handler. `startUnit` reaches the
      // presenter, and the live one draws into Ink — one bad frame throwing
      // would otherwise become an unhandled rejection, which on this Node ends
      // the process and takes every running session with it.
      running.finally(() => sessions.delete(running)).catch(() => {});
    }
  };

  /**
   * Say, once, that no more polls are coming.
   *
   * Idempotent because three paths reach it and two of them can happen together:
   * a signal, a key, and the loop simply running out of reasons to continue.
   */
  const enterFinishing = () => {
    if (finishing) return;
    finishing = true;
    say({ kind: "phase", phase: { kind: "finishing" } });
  };

  const onStop = () => {
    // **A second interrupt gets out, and that is not a nicety.** This handler
    // replaces Node's default, and the first one starts a wait that is bounded
    // by each session's grace rather than by anything immediate. Without this,
    // pressing Ctrl-C again would do nothing at all and the terminal would be
    // held for as long as the slowest harness took to die.
    if (stop.stopped) {
      process.off("SIGINT", onStop);
      process.off("SIGTERM", onStop);
      process.kill(process.pid, "SIGINT");
      return;
    }
    stop.stopped = true;
    // Said before the wait rather than after it: every running session is now
    // given its grace period, which can be minutes, and a screen still showing a
    // countdown through that is counting down to a poll that will never happen.
    enterFinishing();
    stop.wake?.();
    // Polling stops, and every running session is asked to stop with it. Each
    // one insists after its own grace; the wait below is what gives them it.
    for (const stopper of [...stoppers]) stopper();
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  /**
   * What a keypress asks for, answered here rather than in the view.
   *
   * **Stopping is the same path a signal takes**, which is not a tidiness: the
   * live view reads keys, reading keys puts the terminal in raw mode, and a
   * terminal in raw mode never turns Ctrl-C into the signal `onStop` is
   * registered for. Routing the key to the same handler is what keeps a second
   * press an escape and a first press a graceful stop.
   *
   * **A poll is asked for, not performed.** The answer is a pure decision, the
   * refusal is said out loud so a key never looks dropped, and all a taken one
   * does is end the wait the loop is sitting in — the loop is still the only
   * thing that polls, claims and spawns.
   */
  const onRequest = (request: ViewRequest) => {
    if (request === "quit") {
      onStop();
      return;
    }
    const answer = answerPollNow(deps.now().getTime(), { polling, finishing, lastTakenAt: lastAskedAt });
    say({ kind: "asked", taken: answer.kind === "taken", reason: answer.reason });
    if (answer.kind !== "taken") return;
    lastAskedAt = deps.now().getTime();
    pollAsked = true;
    stop.wake?.();
  };
  presenter.listen(onRequest);

  /**
   * One tick, with the runner saying where it is on either side of it.
   *
   * The phase is an event rather than something the view works out, because a
   * countdown the screen invented would be the second route to runner state that
   * the two-presenter rule exists to forbid. `null` means *polling now*; a
   * number is the moment the next poll is due.
   */
  const runTick = async (): Promise<void> => {
    polling = true;
    say({ kind: "phase", phase: { kind: "polling" } });
    try {
      await tick();
    } finally {
      polling = false;
    }
  };

  try {
    const pollMs = durationMs(config.poll)!;
    // Once immediately at start, then on the interval: a runner that waited a
    // full poll before its first look would spend five minutes looking stopped.
    await runTick();
    while (!once && !stop.stopped && sessionEnded === null) {
      // The deadline is said before the wait rather than derived from it, and a
      // poll a person asks for cuts the wait short — so the next one is a full
      // interval after the poll that actually happened, not the remainder of an
      // interval nobody waited out.
      if (!pollAsked) {
        say({ kind: "phase", phase: { kind: "waiting", at: deps.now().getTime() + pollMs } });
        await deps.sleep(pollMs, stop);
      }
      pollAsked = false;
      if (stop.stopped) break;
      await runTick();
    }
    // Every session this process started is waited for, whether it is stopping
    // or simply finishing one tick: a claim that has been spent must not be
    // abandoned half-run without its row in the log. **The wait is the point of
    // saying this here**: `--once` reaches it after one tick and a run whose
    // session the server ended reaches it too, and either can sit here for as
    // long as a session takes with the view still drawn.
    enterFinishing();
    await Promise.all([...sessions]);
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
  }

  const lost = [...work.values()].reduce((total, w) => total + w.queue.length, 0);
  say({ kind: "stopped", lostQueued: lost });
  await presenter.stop();
  // The session ending is the one thing that stops the loop by itself, and it is
  // said on stderr after the view is gone — it is what a person has to act on.
  if (sessionEnded !== null) {
    err(sessionEnded);
    return 1;
  }
  return once && anyFailed ? 1 : 0;
}

/**
 * One session, from the invocation to the outcome.
 *
 * Split out so the whole of what a session *is* reads in one place: fetch the
 * key, build the argv, spawn it, read what came back. Every failure on the way
 * is an outcome rather than a throw, for the reason `execute.ts` gives — an agent
 * left in the running set is one that is never asked for work again.
 */
async function oneSession(
  deps: RunDeps,
  keyStore: ConnectionKeyStore,
  entry: AgentEntry,
  unit: WorkUnit,
  onStop: StopRegistry,
): Promise<Outcome> {
  const agent = unit.instruction.agent;
  const spec = harnessFor(entry.harness);

  if (credentialsCollide(spec, entry.env.connectionKey)) {
    // Refused rather than resolved: either resolution hands one credential to
    // the thing expecting the other, and both fail somewhere far from here.
    return spawnFailed(
      `${agent}'s connection key and its harness credential are both \`${spec.credentialVariable}\`. ` +
        "One variable cannot hold both; give the connection key its own name in config.json.",
    );
  }

  let connectionKey: string | null;
  try {
    connectionKey = await keyStore.get(entry.id);
  } catch (cause) {
    return spawnFailed(`the connection key could not be read: ${(cause as Error).message}`);
  }
  if (connectionKey === null) {
    return spawnFailed(
      `there is no connection key for ${agent} on this machine. Run \`mdbrain configure\` to ask the server for one.`,
    );
  }

  const harnessCredential = entry.env.harness === null ? null : (deps.env[entry.env.harness] ?? null);
  if (entry.env.harness !== null && harnessCredential === null) {
    // Held at startup, so reaching here means the variable went away while the
    // process was running. Said as an outcome rather than a crash.
    return spawnFailed(`${entry.env.harness} is no longer set, so the harness has no credential.`);
  }

  // Rendered before anything is spawned, so a prompt naming something that
  // cannot be resolved costs one unit of work and no money. This is the whole
  // reason the check is here and not inside the harness's own arguments: past
  // this line a session exists, and a session that ran on a broken prompt reads
  // exactly like one that worked.
  const rendered = renderPrompt(unit.instruction.prompt, unit.instruction.file);
  if (!rendered.ok) return spawnFailed(rendered.reason);

  const spawnable = spec.build({
    prompt: rendered.prompt,
    claimId: unit.instruction.claim,
    mcpConfigPath: mcpConfigPath(agent),
    cwd: entry.cwd,
    bounds: entry.bounds,
    harnessCredential,
    connectionKeyVariable: entry.env.connectionKey,
    connectionKey,
    parentEnv: deps.env,
  });

  const ending = await deps.startSession({
    spawnable,
    cwd: entry.cwd,
    wallClockMs: durationMs(entry.bounds.wallClock)!,
    onStop,
  });
  if (ending.spawnProblem !== null) return spawnFailed(ending.spawnProblem);

  return readOutcome({
    stdout: ending.stdout,
    stderr: ending.stderr,
    exitCode: ending.exitCode,
    timedOut: ending.timedOut,
    stopped: ending.stopped,
    signal: ending.signal,
    credentialVariable: entry.env.harness,
  });
}

/** An outcome for a session that never started. */
function spawnFailed(message: string): Outcome {
  return {
    kind: "spawn-failed",
    message,
    sessionId: null,
    costUsd: null,
    turns: null,
    durationMs: null,
    exitCode: null,
    signal: null,
  };
}

/** `mdbrain run`, as the registry declares it. */
export const run: CommandSpec = {
  name: "run",
  summary: "poll for the configured agents' work and start a session for each unit",
  flags: [{ name: "once", summary: "one poll, then exit" }],
  run(context) {
    return runRun(defaultDeps, context);
  },
};
