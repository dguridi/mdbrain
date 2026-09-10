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
import {
  appendDiagnosis,
  redactSecrets,
  refusedMessage,
  refusedRow,
  runtimeFacts,
  startRow,
  stopRow,
  type RefusedCall,
  type RefusedRow,
} from "../run/diagnosis.ts";
import { dayLine, plainPresenter, type Presenter, type RunEvent } from "../run/present.ts";
import { livePresenter } from "../run/screen.ts";
import type { ViewRequest } from "../run/keys.ts";
import { readySession } from "./session.ts";
import { latestVersion } from "../upgrade/latest.ts";
import { isCompiledExecPath, type Channel } from "../upgrade/plan.ts";
import { VERSION_CHECK_TIMEOUT_MS, versionCheckDue, versionNoticeFor } from "../upgrade/notice.ts";
import { CHANNEL, VERSION } from "../version.ts";

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
  /**
   * Appends one row to the diagnosis log — the start, a refusal, the stop.
   *
   * A separate edge from `recordRun` rather than a second use of it, because the
   * two files answer different questions and a test that wanted to assert one
   * would otherwise have to filter the other out of it.
   */
  recordDiagnosis: typeof appendDiagnosis;
  /** Waits, or resolves at once when something asks the loop to stop. */
  sleep: (ms: number, signal: { stopped: boolean; wake: (() => void) | null }) => Promise<void>;
  now: () => Date;
  /**
   * What the latest published version is, or null when it could not be
   * established. The same lookup `upgrade` uses, on a period rather than on
   * demand — one implementation of the question, because two would eventually
   * disagree about what *latest* means.
   */
  lookupLatest: (signal: AbortSignal) => Promise<string | null>;
  /**
   * What this build is, which is what the notice is compared against and what
   * decides the remedy it names.
   *
   * Injected rather than read from `version.ts` at the point of use, because the
   * three facts together are an edge like any other: a test that could not vary
   * them could only ever assert the sentence this very binary would print.
   */
  build: { version: string; channel: Channel; isCompiled: boolean };
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
  recordDiagnosis: appendDiagnosis,
  sleep: waitFor,
  now: () => new Date(),
  lookupLatest: (signal) => latestVersion(fetch, undefined, signal),
  build: { version: VERSION, channel: CHANNEL, isCompiled: isCompiledExecPath(process.execPath) },
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
      // Redacted for the same reason the polled calls' words are: this is a body
      // written by whatever answered, and a proxy or gateway that echoes the
      // request echoes the bearer token with it. The roster is the third call
      // authorised the same way, so it carries the same risk.
      err(`${refused} (the server said: ${redactSecrets((cause as Error).message)})`);
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
  // Every event is stamped once, here, and the same stamp is what the log prints
  // and what the screen remembers — so a row and a line cannot disagree about
  // when something happened.
  //
  // **The date is announced by the runner rather than invented by a presenter**,
  // which is why it goes through `say` at all: a presenter that decided when to
  // print a date would be originating a fact, and the one thing a presenter may
  // originate is what the person asked for. `dayLine` holds the decision and is
  // pure; this holds only the stamp it last announced against.
  let announced: Date | null = null;
  const say = (event: RunEvent) => {
    const at = deps.now();
    const date = dayLine(announced, at);
    if (date !== null) {
      announced = at;
      presenter.present({ kind: "day", date }, at);
    }
    presenter.present(event, at);
  };

  for (const agent of startup.asking) say({ kind: "configured", agent });
  for (const held of startup.held) say({ kind: "held", agent: held.agent, reason: held.reason });
  for (const renamed of renamedAgents(config, rosterById)) {
    say({
      kind: "note",
      message: `${renamed.configuredAs} is now called ${renamed.nowCalled} in the roster. Run \`mdbrain configure\` so the two agree; until then it will receive no work.`,
    });
  }
  say({ kind: "summary", lines: summaryLines(startup, config, runLogPath(), keyStorageLine(keyStore.backend)) });

  /**
   * Write one diagnosis row, never letting it become the reason anything failed.
   *
   * The whole point of the file is to explain a failure, so a run that refused to
   * proceed because it could not open its own notebook would have turned a
   * diagnostic into an outage. A failed write is one note and the run carries on.
   */
  const record = async (row: Parameters<typeof appendDiagnosis>[0]) => {
    try {
      await deps.recordDiagnosis(row);
    } catch (cause) {
      say({ kind: "note", message: `The diagnosis log could not be written: ${(cause as Error).message}` });
    }
  };

  // Written before the all-held refusal below rather than after it: a run that
  // starts and immediately finds nobody to ask is exactly a run somebody will
  // later want a record of, and it is one of the two shapes this whole file
  // exists for — the other being a key store that turned out to be the wrong one.
  await record(
    startRow(deps.now(), {
      // The same three facts the notice is compared against, read from the one
      // seam that holds them rather than from `version.ts` a second time: two
      // readings of one build are two things that can disagree, and the run
      // writing this row is the run the notice is about.
      version: deps.build.version,
      channel: deps.build.channel,
      compiled: deps.build.isCompiled,
      runtime: runtimeFacts(),
      keyStore: keyStore.backend.kind,
      keyStoreWhere: keyStore.backend.where,
      configPath: configPath(),
      asking: [...startup.asking],
      held: startup.held.map((h) => ({ agent: h.agent, reason: h.reason })),
      pollMs: durationMs(config.poll) ?? 0,
    }),
  );

  if (startup.asking.length === 0) {
    await record(stopRow(deps.now(), "all-held", 1, 0));
    await presenter.stop();
    err(ALL_HELD_MESSAGE);
    return 1;
  }

  const work = new Map<string, AgentWork>();
  for (const agent of startup.asking) work.set(agent, { running: false, queue: [] });
  const busy = () => new Set([...work].filter(([, w]) => w.running).map(([agent]) => agent));
  const depths = () => new Map([...work].map(([agent, w]) => [agent, w.queue.length]));

  const stop = { stopped: false, wake: null as (() => void) | null };
  /** Whether the presenter is still drawing, which is what may still be said to. */
  let presenting = true;
  /**
   * The check in flight, so a stop can cut it short rather than be held by it.
   *
   * **This program sets an exit code and lets the event loop drain rather than
   * calling `process.exit`**, which is what makes an outstanding request a thing
   * that delays the prompt instead of a thing that is discarded.
   */
  let versionCheckAbort: AbortController | null = null;
  /** Abandon it, if there is one. Both a stop and the last line reach for this. */
  const abortVersionCheck = () => versionCheckAbort?.abort();
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
  /** How many sessions this process started, so a stop row reads as a history rather than a list. */
  let sessionsStarted = 0;

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
    sessionsStarted += 1;
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
   *
   * @param call which of the two polled calls this was, which is the half of the
   *   sentence that used to be missing: both are authorised the same way and both
   *   answer the same refusal, so without it the only way to tell the count from
   *   the claim is that one of them happens not to name the server's words.
   * @returns the sentence to end the run with **and** the row to write it down as,
   *   together rather than separately so the two can never say different things
   *   about the same refusal.
   */
  const refusal = (cause: unknown, call: RefusedCall): { message: string; row: RefusedRow } | null => {
    if (!(cause instanceof AuthError)) return null;
    const said = signInAgainMessage(cause.status);
    if (said === null) return null;
    return {
      message: refusedMessage(said, call, cause.status, cause.message),
      row: refusedRow(deps.now(), call, cause.status, cause.message),
    };
  };

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
      const refused = refusal(cause, "count");
      if (refused) {
        await record(refused.row);
        sessionEnded = refused.message;
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
      const refused = refusal(cause, "claim");
      if (refused) {
        await record(refused.row);
        sessionEnded = refused.message;
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
    // The version check is the one outstanding request nothing is waiting on,
    // and a person who pressed Ctrl-C is owed a prompt rather than a lookup.
    abortVersionCheck();
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

  /** When a version check was last *started*, which is what the period is measured from. */
  let versionCheckedAt: number | null = null;
  /** Whether one is still going, so a slow lookup is not started again beneath itself. */
  let versionCheckRunning = false;
  /** The version already announced, so a second check finding the same tag says nothing. */
  let versionAnnounced: string | null = null;

  /**
   * Look up the published version if one is due, and say so if there is
   * something to say.
   *
   * **Started and not awaited, which is the decision worth reading.** This is a
   * poll loop whose entire value is that it asks the server on time, and an
   * awaited network call would put the timeliness of every poll behind a request
   * to a third party. The notice is the least urgent thing this process does and
   * must not be able to delay the most urgent.
   *
   * **Not awaiting it is not the same as being free of it**, and that is the part
   * that is easy to get wrong: this program sets an exit code and lets the loop
   * drain, so an outstanding request keeps the process alive whether anything is
   * waiting on it or not. `fetch` gives up after five minutes of its own accord,
   * which is five minutes a person who pressed Ctrl-C spends watching a prompt
   * that has not come back. So the request is bounded by
   * `VERSION_CHECK_TIMEOUT_MS` and is aborted outright when the run ends.
   *
   * **Nothing is said once the presenter has been told to stop.** An answer that
   * arrives after the screen is gone would be printed by the plain presenter
   * anyway — it has no such guard — landing a line beneath the one that says the
   * runner stopped.
   *
   * **The in-flight flag is what makes the period true rather than nominal.** The
   * stamp is taken when the check starts, so a lookup that is slow past the next
   * due time is not joined by a second one.
   */
  const checkVersion = () => {
    const at = deps.now().getTime();
    if (versionCheckRunning || !versionCheckDue(versionCheckedAt, at)) return;
    versionCheckRunning = true;
    versionCheckedAt = at;
    const abort = new AbortController();
    versionCheckAbort = abort;
    // Unref'd, so the timer that bounds the request is not itself a reason the
    // process stays up.
    const giveUp = setTimeout(() => abort.abort(), VERSION_CHECK_TIMEOUT_MS);
    giveUp.unref?.();
    void deps
      .lookupLatest(abort.signal)
      .then((latest) => {
        if (!presenting) return;
        const notice = versionNoticeFor(deps.build.version, latest, deps.build.channel, deps.build.isCompiled);
        // Null is a failed lookup — including one this runner abandoned — or a
        // version that is already current, and every one of those is silent:
        // nothing to the screen and nothing to the run log. A log line for the
        // failure was offered and declined; it is not an oversight.
        if (notice === null || notice.version === versionAnnounced) return;
        versionAnnounced = notice.version;
        say({ kind: "version", version: notice.version, how: notice.how });
      })
      // A frame that threw while drawing the notice must not become an unhandled
      // rejection, which on this Node ends the process and takes every running
      // session with it.
      .catch(() => {})
      .finally(() => {
        clearTimeout(giveUp);
        versionCheckRunning = false;
        if (versionCheckAbort === abort) versionCheckAbort = null;
      });
  };

  /**
   * One tick, with the runner saying where it is on either side of it.
   *
   * The phase is an event rather than something the view works out, because a
   * countdown the screen invented would be the second route to runner state that
   * the two-presenter rule exists to forbid. `null` means *polling now*; a
   * number is the moment the next poll is due.
   */
  const runTick = async (): Promise<void> => {
    // Here rather than on its own timer: the tick is already the thing that
    // happens regularly, and a second timer would be a second thing to stop.
    // The period is the gate, so a one-minute poll does not mean a one-minute
    // check.
    checkVersion();
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
  } catch (cause) {
    // A throw that escapes the loop is still an ending, and the one thing this
    // file must never leave is a start with nothing after it — that is
    // indistinguishable from the process being killed outright, which is exactly
    // the ambiguity it exists to remove. The throw is re-raised unchanged; all
    // that happens here is that it stops being invisible.
    await record(stopRow(deps.now(), "threw", 1, sessionsStarted));
    throw cause;
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
  }

  // The exit is written down as well as printed, and that is the gap this closes:
  // a run log holds one row per finished session and nothing at all for a runner
  // that stopped without finishing one, which is precisely the case somebody is
  // trying to explain the next morning.
  //
  // **Written before the presenter is told to stop**, because a failed write says
  // so through `say` — and a note said after the screen is gone is a line the
  // plain presenter would put underneath the one announcing the runner stopped.
  const code = sessionEnded !== null ? 1 : once && anyFailed ? 1 : 0;
  const why = sessionEnded !== null ? "session-ended" : stop.stopped ? "signal" : once ? "once" : "finished";
  await record(stopRow(deps.now(), why, code, sessionsStarted));

  const lost = [...work.values()].reduce((total, w) => total + w.queue.length, 0);
  say({ kind: "stopped", lostQueued: lost });
  // Both halves, and they are not the same thing: the abort stops the request
  // holding the process open past its last line, and the flag stops an answer
  // that is already on its way from being printed under it.
  presenting = false;
  abortVersionCheck();
  await presenter.stop();
  // The session ending is the one thing that stops the loop by itself, and it is
  // said on stderr after the view is gone — it is what a person has to act on.
  if (sessionEnded !== null) {
    err(sessionEnded);
    return 1;
  }
  return code;
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
