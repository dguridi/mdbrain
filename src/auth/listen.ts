// The listener that catches the browser coming back, and the browser launch.
//
// The two impure halves of the login, kept together because they are the same
// short-lived arrangement: a server that exists for one request, and the tab
// that will make it.
//
// **The port floats.** RFC 8252 asks for it, and a fixed port is one another
// local program can be holding — a failure that arrives at the worst moment and
// for no reason the person can act on. Binding zero asks the operating system
// for whatever is free.

import { createServer, type IncomingMessage } from "node:http";
import { spawn } from "node:child_process";
import {
  handoverRefusalMessage,
  readHandover,
  routeHandoverRequest,
  type HandoverRefusal,
} from "./handover.ts";
import type { StoredSession } from "./session.ts";

/** How long to wait for a person to finish signing in before giving up. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** A listener waiting for one session, and where the browser should send it. */
export interface Loopback {
  /** The port it got, which the app's page is told to post to. */
  port: number;
  /** Resolves with the session, or rejects when the wait runs out. */
  session: Promise<StoredSession>;
  /** Stop listening, whatever happened. */
  close(): void;
}

/** Where a refusal is reported while the wait continues. */
export type Report = (line: string) => void;

/**
 * Read a request body, capped so nothing local can exhaust this by talking.
 *
 * **Every path settles, and `close` is the listener that makes that true.**
 * Reaching the cap destroys the request, which emits neither `end` nor `error` —
 * so waiting only on those hangs on exactly the oversized payload somebody
 * probing this would send, leaving it not merely unanswered but unreported,
 * which is the one thing this listener must never do. Removing `close` and
 * driving a body past the cap is what shows it.
 */
function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(body);
    };
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > limit) {
        body = body.slice(0, limit);
        req.destroy();
      }
    });
    req.on("end", settle);
    req.on("close", settle);
    req.on("error", settle);
  });
}

/**
 * Start listening on a loopback port for the app to hand a session over.
 *
 * **Only a session ends the wait, and only the first one.** Every other request
 * is answered, reported and ignored — that is what stops anything else on the
 * machine from abandoning a login in flight, which matters because the challenge
 * is the only thing that says a request belongs to this login.
 *
 * **The one-shot flag is about the answer, not the session.** A settled promise
 * keeps its first value, so a replay could never have displaced what the command
 * stores — but without the flag it would still be told *signed in, close this
 * tab* and pass unreported, which is a listener volunteering that it holds a
 * live session to whatever asked.
 *
 * @param expectedChallenge this login's challenge, which the app echoes back
 * @param port the port to bind, or 0 to let the operating system choose
 */
export function listenForSession(
  expectedChallenge: string,
  report: Report,
  port = 0,
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<Loopback> {
  return new Promise((resolveLoopback, rejectLoopback) => {
    let settle: ((session: StoredSession) => void) | null = null;
    let fail: ((reason: Error) => void) | null = null;
    const session = new Promise<StoredSession>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    // The wait is one-shot: the first correct challenge takes the session, and
    // every later request is refused whatever it carries.
    let handedOver = false;

    const server = createServer((req, res) => {
      void (async () => {
        // A socket that is already gone — the caller hung up, or the body cap
        // destroyed it — cannot be written to, and that must not stop the
        // refusal being reported.
        const answer = (body: string) => {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(body);
        };
        // Every refusal is reported, the ones decided before the body is read
        // included. A request answered in silence is one nobody can notice.
        const refuse = (reason: HandoverRefusal) => {
          answer("That was not a sign-in for this command.\n");
          report(handoverRefusalMessage(reason));
        };
        const route = routeHandoverRequest({ method: req.method ?? null, url: req.url ?? null });
        if (route.kind === "refuse") {
          refuse(route.reason);
          return;
        }
        if (handedOver) {
          refuse("already-handed-over");
          return;
        }
        const reading = readHandover(
          {
            contentType: req.headers["content-type"] ?? null,
            body: await readBody(req),
          },
          expectedChallenge,
        );
        // Checked again, because the check above happened before `readBody`
        // awaited and two handovers can overlap on the wire — a retried form
        // POST, a double submit, or something local racing the browser. Only
        // here are the test and the assignment in one synchronous step, which is
        // what makes the wait actually one-shot rather than nearly one.
        if (reading.kind === "session" && handedOver) {
          refuse("already-handed-over");
          return;
        }
        if (reading.kind === "session") {
          handedOver = true;
          answer("Signed in. You can close this tab.\n");
          settle?.({
            accessToken: reading.accessToken,
            refreshToken: reading.refreshToken,
            expiresAt: reading.expiresAt,
          });
          return;
        }
        refuse(reading.reason);
      })();
    });

    const timer = setTimeout(() => {
      fail?.(new Error("Timed out waiting for the browser to come back."));
      server.close();
    }, timeoutMs);
    // The timer must not be what keeps the process alive once the session lands.
    timer.unref?.();

    server.once("error", (cause: NodeJS.ErrnoException) => {
      // Nobody receives `session` when the bind fails, so the armed timeout
      // would later reject a promise with no owner. Clearing it and marking the
      // rejection handled keeps a refused port from surfacing minutes later as
      // an unhandled rejection in whatever process is still running.
      clearTimeout(timer);
      void session.catch(() => {});
      // Naming the port is the whole of what makes this actionable: a chosen
      // port can be held by anything, and "could not listen" without it leaves
      // the person nothing to look for.
      rejectLoopback(
        cause.code === "EADDRINUSE"
          ? new Error(`Port ${port} is already in use, so the sign-in cannot be received there.`)
          : cause,
      );
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectLoopback(new Error("The listener did not report a port."));
        return;
      }
      resolveLoopback({
        port: address.port,
        session,
        close: () => {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}

/** How a URL is handed to one platform's opener. */
export interface BrowserLaunch {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * How a given platform is asked to open a URL.
 *
 * **Windows needs the URL quoted, and getting that wrong is silent.** `cmd`
 * reads `&` as a command separator, so an unquoted URL arrives at the browser
 * truncated at its first parameter. The quotes have to survive Node's own
 * argument handling too, hence `windowsVerbatimArguments`; `start`'s first
 * quoted argument is a window title, which is why there is an empty pair before
 * the URL.
 *
 * Separated from {@link openBrowser} because the quoting is the half that fails
 * silently, and a pure function can be checked wherever the suite runs — driving
 * `cmd` itself can only say anything on Windows.
 *
 * @param platform the platform to build the invocation for, not necessarily this one
 */
export function browserLaunch(platform: NodeJS.Platform, url: string): BrowserLaunch {
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", '""', `"${url}"`], windowsVerbatimArguments: true };
  }
  return {
    command: platform === "darwin" ? "open" : "xdg-open",
    args: [url],
    windowsVerbatimArguments: false,
  };
}

/**
 * Ask the operating system to open a URL.
 *
 * Best effort by design: the URL is printed by the caller either way, which is
 * the only thing that works over SSH or in a terminal with no session bus. A
 * failure to launch is not a failure to log in.
 */
export function openBrowser(url: string): void {
  try {
    const launch = browserLaunch(process.platform, url);
    const child = spawn(launch.command, launch.args, {
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL is the fallback, and it is always printed.
  }
}
