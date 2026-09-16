// Spawning one harness session, and the two signals that end one that overstays.
//
// The impure edge, deliberately thin: everything about *what* to spawn is
// decided in `harness.ts` and everything about what the result means is decided
// in `outcome.ts`, so what is left here is a process, a timer and two kills.
//
// **It always resolves.** A failure to spawn is an outcome rather than an
// exception, because the caller keeps a set of agents with a session running and
// a throw would leave an agent in it forever — which looks exactly like an agent
// that is busy, and is the one state from which it is never asked for work again.
//
// **The child is its own process group on POSIX**, so the tools a session starts
// die with it. A harness that spawns a language server and is killed without its
// group leaves the language server holding the terminal.
//
// **There are two spawns here and not one spawn with a mode on it.** An
// unattended session captures its streams, is detached, and is bounded by a wall
// clock; an attended one inherits all three streams, must not be detached, and
// has no outer bound at all. They differ in every field that matters, so a single
// function taking a boolean would read as one behaviour with a switch in it
// rather than as two things that happen to share a spawn call. What they do share
// is the rule in the paragraph above: both always resolve.

import { spawn } from "node:child_process";
import type { Spawnable } from "./harness.ts";

/** How long to wait, after asking a session to stop, before killing it. */
export const GRACE_MS = 30_000;

/** What a finished session left behind, whatever ended it. */
export interface SessionEnding {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The runner was asked to stop and ended this session early. */
  stopped: boolean;
  /** Which signal ended the session; null when neither the wall clock nor a stop fired. */
  signal: "term" | "kill" | null;
  /** Set when the process never started at all. */
  spawnProblem: string | null;
}

/**
 * Registers something to call when the runner is asked to stop, and answers how
 * to unregister it.
 *
 * A session **must** be reachable this way, and it is not merely tidiness on
 * POSIX: the child is spawned `detached`, in its own process group, precisely so
 * that killing it reaches the tools it started — and the cost of that is that
 * the terminal's own Ctrl-C never reaches it. Without this the runner would exit
 * while its harness sessions carried on with no terminal and nobody watching.
 */
export type StopRegistry = (stopper: () => void) => () => void;

/** What one session needs from the outside world. */
export interface SessionRequest {
  spawnable: Spawnable;
  cwd: string;
  wallClockMs: number;
  graceMs?: number;
  /** How this session learns the runner is stopping. */
  onStop?: StopRegistry;
}

/** The pieces a test stands in for, so none of this needs a real harness. */
export interface ExecuteDeps {
  spawn: typeof spawn;
  /** Whether this platform has signals worth sending, which decides the grace. */
  isWindows: boolean;
}

const defaultDeps: ExecuteDeps = { spawn, isWindows: process.platform === "win32" };

/**
 * Stop a running child, hardest-first on Windows and politely elsewhere.
 *
 * On POSIX the negative pid addresses the whole process group, which is what the
 * `detached` spawn above created. On Windows there is no group and no SIGTERM to
 * send, so `taskkill /T /F` is the only thing that reaches a tree; the grace
 * period is skipped there because there is nothing to be polite with, and the
 * outcome records which of the two happened.
 */
function stopChild(child: ReturnType<typeof spawn>, hard: boolean, isWindows: boolean): void {
  if (child.pid === undefined) return;
  if (isWindows) {
    // A fourth thing this program shells out to, and only on the path where
    // nothing else works: Node's `kill` reaches the child and not the tree.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
    return;
  }
  try {
    process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM");
  } catch {
    // The group is already gone, which is the outcome the kill was asking for.
    try {
      child.kill(hard ? "SIGKILL" : "SIGTERM");
    } catch {
      // Nothing left to signal.
    }
  }
}

/**
 * Run one harness session to its end.
 *
 * stdout is captured whole because the result object is one object at the end of
 * it; stderr is captured because it is the only thing a harness that died
 * without printing a result has to say.
 *
 * @returns what the session left behind — never a rejection
 */
export function runSession(request: SessionRequest, deps: ExecuteDeps = defaultDeps): Promise<SessionEnding> {
  const { spawnable, cwd, wallClockMs } = request;
  const graceMs = request.graceMs ?? GRACE_MS;

  return new Promise<SessionEnding>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = deps.spawn(spawnable.command, spawnable.args, {
        cwd,
        env: spawnable.env,
        // Its own process group where there is one, so the kill below reaches
        // whatever the session started as well as the session.
        detached: !deps.isWindows,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        stopped: false,
        signal: null,
        spawnProblem: (cause as Error).message,
      });
      return;
    }

    // **Chunks are kept as bytes and decoded once at the end.** A UTF-8
    // sequence can straddle a chunk boundary, and decoding each chunk on its own
    // turns one character into two replacement characters — in the harness's own
    // `result` text, which routinely carries em dashes and quotes. `JSON.parse`
    // still succeeds on the mangled string, so the corruption would be silent
    // rather than loud.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let stopped = false;
    let signal: "term" | "kill" | null = null;
    let settled = false;
    let hardKill: ReturnType<typeof setTimeout> | null = null;

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    /**
     * Ask the session to end, then insist.
     *
     * The same two signals whether the wall clock fired or the runner is
     * stopping: SIGTERM leaves the turn unfinished and resumable, and SIGKILL
     * after the grace is for a harness that ignores it, which is exactly the
     * case both paths exist for. On Windows there is no polite signal, so the
     * grace is skipped and the outcome records that it was.
     */
    const end = () => {
      signal = deps.isWindows ? "kill" : "term";
      stopChild(child, deps.isWindows, deps.isWindows);
      if (deps.isWindows) return;
      hardKill = setTimeout(() => {
        signal = "kill";
        stopChild(child, true, false);
      }, graceMs);
      hardKill.unref?.();
    };

    const wallClock = setTimeout(() => {
      timedOut = true;
      end();
    }, wallClockMs);
    wallClock.unref?.();

    const unregister = request.onStop?.(() => {
      if (settled || stopped || timedOut) return;
      stopped = true;
      end();
    });

    const settle = (exitCode: number | null, spawnProblem: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClock);
      // **Cleared, and this is not tidiness.** A child that answered SIGTERM
      // within the grace has exited and been reaped by the time this runs; an
      // orphaned timer firing afterwards sends SIGKILL to a process *group id*
      // that the operating system is free to have handed to something else —
      // plausibly a harness session this same runner started seconds ago, which
      // would die with nothing anywhere to say why.
      if (hardKill !== null) clearTimeout(hardKill);
      unregister?.();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        timedOut,
        stopped,
        signal,
        spawnProblem,
      });
    };

    // `error` is the command not being there and the `cwd` being gone. It is an
    // outcome and never a throw, for the reason in this file's header.
    child.on("error", (cause: Error) => settle(null, cause.message));
    child.on("close", (code) => settle(code, null));
  });
}

/** What one attended session needs: something to spawn, and where. */
export interface AttachedRequest {
  spawnable: Spawnable;
  cwd: string;
}

/**
 * What an attended session needs beyond an unattended one: a way to give the
 * terminal's input back before the child is handed it.
 *
 * It is a dependency rather than a call because the **order** is the whole of
 * it, and an order nothing can observe is an order nothing can hold.
 */
export interface AttachedDeps extends ExecuteDeps {
  releaseInput: () => void;
}

/**
 * Give the terminal's input back to whoever reads it next.
 *
 * A screen drawn before an attended session puts the terminal in raw mode to
 * read keys, and unmounting turns raw mode off again — but it does not stop
 * this process *reading*. A parent still reading the console while a child
 * reads the same console is **two readers for one keyboard**: each keystroke
 * goes to whichever asks for it first, so the child's first prompt looks dead
 * and the terminal looks hung. `pause()` is what stops the read, down to the
 * handle; the raw-mode reset is for a screen that left it on and costs nothing
 * when it did not.
 *
 * Each step is guarded on its own: neither is worth failing a session over, and
 * a stdin that is not a terminal has no raw mode to reset.
 */
export function releaseTerminalInput(stdin: NodeJS.ReadStream = process.stdin): void {
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
  } catch {
    // A stdin that refuses the mode change is one that was never in it.
  }
  try {
    stdin.pause();
  } catch {
    // Likewise: a stream that cannot be paused is not one that is reading.
  }
}

const defaultAttachedDeps: AttachedDeps = { ...defaultDeps, releaseInput: () => releaseTerminalInput() };

/** How an attended session ended: the child's own code, or why it never started. */
export interface AttachedEnding {
  /** Null when a signal ended the child, which is what `signal` then names. */
  exitCode: number | null;
  /**
   * The signal that ended the child, or null when it exited on its own.
   *
   * Kept rather than collapsed into the code, because *exited 0* and *was killed*
   * are different answers and only one of them means the session finished. A
   * caller that read a null code as success would report a harness that was
   * killed as a clean run.
   */
  signal: NodeJS.Signals | null;
  /** Set when the process never started at all. */
  spawnProblem: string | null;
}

/**
 * Hand the terminal to one harness session and wait for the person to finish.
 *
 * Three things `runSession` does are removed rather than configured away, and
 * each is a separate reason the two cannot be one function:
 *
 * - **All three streams are inherited.** A harness whose stdout is a pipe has no
 *   terminal to draw on, and one whose stdin is `ignore` has nothing to read.
 * - **The child is not detached.** That is the one that would fail strangely
 *   rather than obviously: a detached child is not the foreground process group,
 *   so its first read from the terminal raises `SIGTTIN` and stops it. It also
 *   means the terminal's own Ctrl-C reaches the child, which is what this
 *   command wants and what `runSession` deliberately gives up.
 * - **There is no wall clock and no stop registry.** An attended session has no
 *   outer bound because the person ends it, and installing a `SIGINT` handler
 *   here would race the harness for a key the harness owns — Claude Code already
 *   has an opinion about what its own interrupt means, and it is *stop the turn*
 *   rather than *end the session*.
 *
 * @returns the child's exit code, or the sentence saying it never started —
 * never a rejection, for the reason this file's header gives
 */
export function runAttached(request: AttachedRequest, deps: AttachedDeps = defaultAttachedDeps): Promise<AttachedEnding> {
  const { spawnable, cwd } = request;

  // **Before the spawn rather than after it.** The child inherits these very
  // streams, so anything this process is still doing with them competes with it
  // from its first keystroke rather than from some later one.
  deps.releaseInput();

  return new Promise<AttachedEnding>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = deps.spawn(spawnable.command, spawnable.args, {
        cwd,
        env: spawnable.env,
        detached: false,
        stdio: "inherit",
      });
    } catch (cause) {
      resolve({ exitCode: null, signal: null, spawnProblem: (cause as Error).message });
      return;
    }

    let settled = false;
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null, spawnProblem: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, spawnProblem });
    };

    child.on("error", (cause: Error) => settle(null, null, cause.message));
    child.on("close", (code, signal) => settle(code, signal, null));
  });
}
