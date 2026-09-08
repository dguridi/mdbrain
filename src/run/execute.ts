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
