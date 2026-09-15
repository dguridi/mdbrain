import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVENTS,
  aggregateListening,
  channels,
  decodeFrame,
  listeningText,
  realtimeTopic,
  type Frame,
  type ListeningState,
} from "../src/run/channel.ts";
import {
  SIGNAL_DEBOUNCE_MS,
  SIGNAL_MAX_DELAY_MS,
  SIGNAL_MIN_GAP_MS,
  clearSignal,
  noSignal,
  signalDelayMs,
  takeSignal,
} from "../src/run/signal.ts";
import { signalLink } from "../src/run/signals.ts";
import type { SocketFactory, SocketHandlers } from "../src/run/realtime.ts";

const BRAIN = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

interface FakeSocket {
  url: string;
  handlers: SocketHandlers;
  sent: string[];
  closed: boolean;
  send(text: string): void;
  close(): void;
}

function fakeSockets(): { opened: FakeSocket[]; factory: SocketFactory } {
  const opened: FakeSocket[] = [];
  const factory: SocketFactory = (url, handlers) => {
    const socket: FakeSocket = {
      url,
      handlers,
      sent: [],
      closed: false,
      send(text) {
        socket.sent.push(text);
      },
      close() {
        socket.closed = true;
      },
    };
    opened.push(socket);
    return socket;
  };
  return { opened, factory };
}

const framesOf = (socket: FakeSocket): Frame[] =>
  socket.sent.map((text) => decodeFrame(text)).filter((frame): frame is Frame => frame !== null);

const joinsOf = (socket: FakeSocket) => framesOf(socket).filter((frame) => frame.event === "phx_join");

function replyTo(socket: FakeSocket, join: Frame, status: "ok" | "error" = "ok") {
  socket.handlers.onMessage(
    JSON.stringify({ topic: join.topic, ref: join.ref, event: "phx_reply", payload: { status, response: {} } }),
  );
}

function deliver(socket: FakeSocket, topic: string, event: string, payload: unknown = {}) {
  socket.handlers.onMessage(
    JSON.stringify({ topic: realtimeTopic(topic), ref: null, event: "broadcast", payload: { event, payload } }),
  );
}

function open(
  brains: string[],
  onSignal: () => void,
  factory: SocketFactory,
  onState?: (state: ListeningState, held: number, total: number) => void,
) {
  return signalLink({
    url: "wss://example.test/realtime/v1/websocket",
    accessToken: "token-1",
    brains,
    onSignal,
    random: () => 0,
    openSocket: factory,
    ...(onState === undefined ? {} : { onState }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the debounce a signal goes through", () => {
  it("117-S14: a burst arms one read rather than one per signal", () => {
    let window = noSignal;
    let armed = 0;
    for (let i = 0; i < 40; i++) {
      const taken = takeSignal(window, 1_000 + i);
      window = taken.window;
      if (taken.arm) armed += 1;
    }
    expect(armed).toBe(1);
    expect(window.dueAt).toBe(1_000 + SIGNAL_DEBOUNCE_MS);
  });

  // The failure this rule exists to prevent: under a signal every second, a timer
  // pushed back by each one never fires, so the busiest brain is the one the
  // runner serves last.
  it("117-S15: a signal every second for a minute reads on the period, rather than never", () => {
    let window = noSignal;
    let reads = 0;
    for (let second = 0; second < 60; second++) {
      const at = second * 1_000;
      if (window.dueAt !== null && at >= window.dueAt) {
        reads += 1;
        window = clearSignal(window, at, at).window;
      }
      window = takeSignal(window, at).window;
    }
    expect(reads).toBeGreaterThanOrEqual(14);
    expect(reads).toBeLessThanOrEqual(20);
  });

  // The failure the debounce alone does not cover: an agent working in a watched
  // brain produces a signal every few seconds, each one outside the last window,
  // each one arming a read that finds nothing — because the claim excludes the
  // very agent whose writes produced the events. Without a floor the feature that
  // exists to reduce calls on the authentication path would multiply them.
  it("117-S14: a stream of signals is held to the rate a poll could have been set to", () => {
    let window = noSignal;
    let lastRead: number | null = null;
    let reads = 0;
    // One signal every second for ten minutes, none of them inside another's window.
    for (let second = 0; second < 600; second++) {
      const at = second * 1_000;
      if (window.dueAt !== null && at >= window.dueAt) {
        reads += 1;
        lastRead = at;
        window = clearSignal(window, at, at).window;
      }
      window = takeSignal(window, at, 0, lastRead).window;
    }
    // Ten minutes at a 30s floor is twenty reads, not two hundred.
    expect(reads).toBeLessThanOrEqual(600_000 / SIGNAL_MIN_GAP_MS + 1);
    expect(reads).toBeGreaterThan(10);
  });

  it("117-S14: and the first signal after a quiet spell is still prompt", () => {
    // The floor must not cost latency in the case signalling exists for: a brain
    // that has been quiet, then one thing happens in it.
    const quiet = takeSignal(noSignal, 10 * 60_000, 0, 0);
    expect(quiet.window.dueAt).toBe(10 * 60_000 + SIGNAL_DEBOUNCE_MS);
  });

  it("a signal that says its work is not claimable yet is read then, not now", () => {
    const armed = takeSignal(noSignal, 0, 60_000);
    expect(armed.arm).toBe(true);
    // The debounce is a floor rather than an addition: a read a minute away does
    // not also need three seconds of burst-folding on top of it.
    expect(armed.window.dueAt).toBe(60_000);
  });

  it("a later prediction is kept rather than folded away, and is read after the earlier one", () => {
    // The failure this exists to prevent, and the one that made a mention never
    // push at all: work claimable now and work claimable in a minute arrive as
    // two signals, and folding the second into the first takes one read before
    // the second's work exists and then never looks again.
    const first = takeSignal(noSignal, 0, 0);
    expect(first.window.dueAt).toBe(SIGNAL_DEBOUNCE_MS);

    const second = takeSignal(first.window, 0, 60_000);
    expect(second.arm).toBe(false);
    // The pending read is not moved out: work that is already claimable must not
    // wait for work that is not.
    expect(second.window.dueAt).toBe(SIGNAL_DEBOUNCE_MS);
    expect(second.window.thenAt).toBe(60_000);

    // The read happens, and the remembered moment is owed one of its own.
    const after = clearSignal(second.window, SIGNAL_DEBOUNCE_MS, SIGNAL_DEBOUNCE_MS);
    expect(after.arm).toBe(true);
    expect(after.window.dueAt).toBe(60_000);
    expect(after.window.thenAt).toBeNull();
  });

  it("a remembered moment that has already passed is not read a second time", () => {
    // A read serves every signal whose work was claimable at or before it, so a
    // remembered moment the read has overtaken needs no read of its own. That is
    // also why a moment inside the pending read is folded rather than remembered:
    // a read at 3s already covers work claimable at 1s.
    expect(takeSignal(takeSignal(noSignal, 0, 0).window, 0, 1_000).window.thenAt).toBeNull();

    const window = takeSignal(takeSignal(noSignal, 0, 0).window, 0, 5_000).window;
    expect(window.thenAt).toBe(5_000);
    // The read ran late — after the remembered moment — so it saw that work too.
    const after = clearSignal(window, 6_000, 6_000);
    expect(after.arm).toBe(false);
    expect(after.window).toEqual(noSignal);
  });

  it("a stream of later predictions still reads, because the floor bounds the re-arm", () => {
    // Someone typing produces a signal every few seconds, each predicting a
    // moment further out. The pending read is never moved, so it happens; the
    // re-arm is floored, so the churn cannot become a read per keystroke.
    let window = takeSignal(noSignal, 0, 60_000).window;
    for (let second = 1; second <= 30; second++) {
      window = takeSignal(window, second * 1_000, 60_000, null).window;
    }
    expect(window.dueAt).toBe(60_000);
    expect(window.thenAt).toBe(90_000);
    const after = clearSignal(window, 60_000, 60_000);
    expect(after.arm).toBe(true);
    expect(after.window.dueAt).toBe(90_000);
  });

  it("a delay the server should never ask for is clamped, and an unreadable one means now", () => {
    expect(signalDelayMs({ in_ms: 60_000 })).toBe(60_000);
    expect(signalDelayMs({ in_ms: 0 })).toBe(0);
    // Clamped rather than trusted: the worst a wrong value may do is move a read,
    // never park one out of reach.
    expect(signalDelayMs({ in_ms: 99 * 60_000 })).toBe(SIGNAL_MAX_DELAY_MS);
    // Every unreadable shape means now, which is what a signal meant before it
    // carried anything — a value nobody can parse must not become silence.
    for (const bad of [{}, { in_ms: -5 }, { in_ms: "60000" }, { in_ms: NaN }, null, "x", 7]) {
      expect(signalDelayMs(bad)).toBe(0);
    }
  });

  it("the window reopens after the read, so the next signal arms again", () => {
    const first = takeSignal(noSignal, 0);
    expect(first.arm).toBe(true);
    expect(takeSignal(first.window, 1).arm).toBe(false);
    expect(takeSignal(clearSignal(first.window, 2, 2).window, 2).arm).toBe(true);
  });
});

describe("the socket that listens for work", () => {
  it("joins every brain's work topic on one socket, privately and in no roster", () => {
    const { opened, factory } = fakeSockets();
    open([BRAIN, OTHER], () => {}, factory);
    expect(opened).toHaveLength(1);
    opened[0].handlers.onOpen();

    const joins = joinsOf(opened[0]);
    expect(joins.map((f) => f.topic)).toEqual([
      realtimeTopic(channels.work(BRAIN)),
      realtimeTopic(channels.work(OTHER)),
    ]);
    for (const join of joins) {
      const config = (join.payload as { config: { private: boolean; presence: { enabled: boolean } } }).config;
      // Private, or it is a different room from the one the policy guards; and no
      // presence, because a runner listening for work is not working.
      expect(config.private).toBe(true);
      expect(config.presence.enabled).toBe(false);
    }
  });

  it("117-S13: a signal tells the runner when, and nothing else whatever it carries", () => {
    const { opened, factory } = fakeSockets();
    const seen: unknown[] = [];
    open([BRAIN], (...args: unknown[]) => seen.push(args), factory);
    opened[0].handlers.onOpen();
    for (const join of joinsOf(opened[0])) replyTo(opened[0], join);

    // One value reaches the runner and it is a duration. A signal carrying a file
    // and a claim beside it hands on neither: there is no parameter to read them
    // through, so nothing downstream can come to depend on identity the sender is
    // free to stop sending.
    deliver(opened[0], channels.work(BRAIN), EVENTS.workArrived, { in_ms: 60_000, fileId: "f-1", claim: "c-1" });
    expect(seen).toEqual([[60_000]]);

    // And a payload that says nothing readable means *now*, which is what every
    // signal meant before one carried anything.
    deliver(opened[0], channels.work(BRAIN), EVENTS.workArrived, { fileId: "f-2" });
    deliver(opened[0], channels.work(BRAIN), EVENTS.workArrived, "not an object");
    expect(seen).toEqual([[60_000], [0], [0]]);
  });

  it("ignores a frame from another room, and any event that is not the signal", () => {
    const { opened, factory } = fakeSockets();
    let signals = 0;
    open([BRAIN], () => (signals += 1), factory);
    opened[0].handlers.onOpen();
    for (const join of joinsOf(opened[0])) replyTo(opened[0], join);

    deliver(opened[0], channels.work(OTHER), EVENTS.workArrived);
    deliver(opened[0], channels.work(BRAIN), EVENTS.filesChanged);
    expect(signals).toBe(0);
    deliver(opened[0], channels.work(BRAIN), EVENTS.workArrived);
    expect(signals).toBe(1);
  });

  it("117-S17: a refused join is asked again, and costs only that brain's signals until it is", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    let signals = 0;
    open([BRAIN, OTHER], () => (signals += 1), factory);
    opened[0].handlers.onOpen();
    const joins = joinsOf(opened[0]);
    replyTo(opened[0], joins[0], "error");
    replyTo(opened[0], joins[1], "ok");

    // The brain that was accepted is unaffected by the other's refusal: the retry
    // is that topic's own and never a re-dial of the socket they share.
    deliver(opened[0], channels.work(OTHER), EVENTS.workArrived);
    expect(signals).toBe(1);
    expect(opened).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    const retried = joinsOf(opened[0]).filter((f) => f.topic === realtimeTopic(channels.work(BRAIN)));
    expect(retried).toHaveLength(2);
    replyTo(opened[0], retried[1], "ok");
    deliver(opened[0], channels.work(BRAIN), EVENTS.workArrived);
    expect(signals).toBe(2);
  });

  it("117-S18: a room the server closes under a live socket is rejoined rather than lost", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    let signals = 0;
    open([BRAIN], () => (signals += 1), factory);
    opened[0].handlers.onOpen();
    replyTo(opened[0], joinsOf(opened[0])[0], "ok");

    // An expired token takes the room and leaves the connection: no close, no
    // error, nothing that would make the socket re-dial of its own accord. What
    // is asserted is the rejoin, because being out of a room is not something
    // this side can observe — the server simply stops sending, which is
    // indistinguishable from a brain with nothing happening in it.
    opened[0].handlers.onMessage(
      JSON.stringify({
        topic: realtimeTopic(channels.work(BRAIN)),
        ref: null,
        event: "phx_error",
        payload: {},
      }),
    );

    vi.advanceTimersByTime(60_000);
    expect(opened).toHaveLength(1);
    const joins = joinsOf(opened[0]);
    expect(joins).toHaveLength(2);
    replyTo(opened[0], joins[1], "ok");
    deliver(opened[0], channels.work(BRAIN), EVENTS.workArrived);
    expect(signals).toBe(1);
  });

  it("117-S19: a fresher token asks again for the rooms it is not in, without waiting out the backoff", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const handle = open([BRAIN, OTHER], () => {}, factory);
    opened[0].handlers.onOpen();
    const joins = joinsOf(opened[0]);
    replyTo(opened[0], joins[0], "ok");
    replyTo(opened[0], joins[1], "error");

    handle.refresh("token-2");
    // The refused room is asked for again at once and on the new token, because a
    // fresher credential is the thing that makes that refusal answer differently.
    const asked = joinsOf(opened[0]).filter((f) => f.topic === realtimeTopic(channels.work(OTHER)));
    expect(asked).toHaveLength(2);
    expect((asked[1].payload as { access_token: string }).access_token).toBe("token-2");
    // And the backoff that was already pending does not then ask a third time.
    vi.advanceTimersByTime(60_000);
    expect(joinsOf(opened[0]).filter((f) => f.topic === realtimeTopic(channels.work(OTHER)))).toHaveLength(2);
  });

  // The eviction here is the server's measured behaviour rather than a guess: a
  // second join of a topic already held on one socket is answered `ok` and the
  // first is closed, and the close frame carries no ref and an empty payload. So
  // a duplicate this side creates is a room it then reads as lost, rejoins, and
  // evicts itself out of again — for as long as the process runs, with signals
  // still arriving throughout and nothing anywhere to see.
  it("117-S20: a room whose join is still in flight is not asked for a second time", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const handle = open([BRAIN], () => {}, factory);
    opened[0].handlers.onOpen();
    expect(joinsOf(opened[0])).toHaveLength(1);

    // The window is one round trip wide and it is the one every startup has: the
    // first tick hands over a token while `onOpen`'s joins are still unanswered.
    handle.refresh("token-2");
    expect(joinsOf(opened[0])).toHaveLength(1);

    // The answer the socket was waiting for still lands, and the room is held.
    replyTo(opened[0], joinsOf(opened[0])[0], "ok");
    vi.advanceTimersByTime(60_000);
    expect(joinsOf(opened[0])).toHaveLength(1);
  });

  it("re-dials on a drop and rejoins everything, on the shared backoff", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    open([BRAIN, OTHER], () => {}, factory);
    opened[0].handlers.onOpen();
    opened[0].handlers.onClosed();
    expect(opened).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(opened).toHaveLength(2);
    opened[1].handlers.onOpen();
    expect(joinsOf(opened[1])).toHaveLength(2);
  });

  it("hands a fresher token to the topics it actually joined", () => {
    const { opened, factory } = fakeSockets();
    const handle = open([BRAIN, OTHER], () => {}, factory);
    opened[0].handlers.onOpen();
    const joins = joinsOf(opened[0]);
    replyTo(opened[0], joins[0], "ok");
    replyTo(opened[0], joins[1], "error");

    handle.refresh("token-2");
    const tokens = framesOf(opened[0]).filter((f) => f.event === "access_token");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].topic).toBe(realtimeTopic(channels.work(BRAIN)));
    expect((tokens[0].payload as { access_token: string }).access_token).toBe("token-2");
  });

  it("117-S25: distinguishes not listening from listening to some of it, and from a socket that never worked", () => {
    const dialling = { held: 0, total: 2, everOpen: false, settled: false };
    expect(aggregateListening({ held: 0, total: 0, everOpen: false, settled: false })).toBe("silent");
    // A first attempt still in flight has not failed, so a healthy startup never
    // draws the one line a person is meant to act on.
    expect(aggregateListening(dialling)).toBeNull();
    expect(aggregateListening({ held: 2, total: 2, everOpen: true, settled: true })).toBe("listening");
    expect(aggregateListening({ held: 1, total: 2, everOpen: true, settled: true })).toBe("partial");
    expect(aggregateListening({ held: 0, total: 2, everOpen: true, settled: true })).toBe("retrying");
    expect(aggregateListening({ held: 0, total: 2, everOpen: false, settled: true })).toBe("unavailable");
    // Every sentence says what is still true of how work arrives, because it is
    // read while somebody is deciding whether the runner is working at all.
    for (const state of ["partial", "retrying", "unavailable", "silent"] as const) {
      expect(listeningText(state, 1, 2)).toContain("poll");
    }
    expect(listeningText("partial", 1, 3)).toContain("1 of 3 brains");
    expect(listeningText("listening", 1, 1)).toContain("1 brain;");
  });

  it("117-S26: says where it stands as the rooms are answered, and says nothing twice", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const said: Array<[ListeningState, number, number]> = [];
    const handle = open([BRAIN, OTHER], () => {}, factory, (state, held, total) => said.push([state, held, total]));
    opened[0].handlers.onOpen();
    // Nothing while the joins are in flight: an unsettled attempt is not news.
    expect(said).toEqual([]);

    const joins = joinsOf(opened[0]);
    replyTo(opened[0], joins[0], "ok");
    replyTo(opened[0], joins[1], "error");
    expect(said).toEqual([["partial", 1, 2]]);

    // The refused room comes back, and the aggregate moves once more.
    vi.advanceTimersByTime(60_000);
    const retried = joinsOf(opened[0]).filter((f) => f.topic === realtimeTopic(channels.work(OTHER)));
    replyTo(opened[0], retried[1], "ok");
    expect(said).toEqual([
      ["partial", 1, 2],
      ["listening", 2, 2],
    ]);

    // A room taken back under a live socket is the state change that used to be
    // invisible on every surface the runner has.
    opened[0].handlers.onMessage(
      JSON.stringify({ topic: realtimeTopic(channels.work(BRAIN)), ref: null, event: "phx_error", payload: {} }),
    );
    expect(said[said.length - 1]).toEqual(["partial", 1, 2]);
    handle.close();
  });

  it("117-S28: a runtime with no socket says so, rather than leaving the line unsaid", () => {
    const said: ListeningState[] = [];
    open([BRAIN], () => {}, () => null, (state) => said.push(state));
    expect(said).toEqual(["unavailable"]);
  });

  // A refused handshake is the failure the presence link reports and this one did
  // not: `openWebSocket` collapses `error` then `close` into one `onClosed`, so a
  // socket that never opened has resolved its first attempt as surely as one that
  // did, and treating it as still in flight leaves the line unsaid for ever.
  it("117-S29: a first dial that never opens says the connection is unavailable, and says so once", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const said: Array<[ListeningState, number, number]> = [];
    const handle = open([BRAIN, OTHER], () => {}, factory, (state, held, total) => said.push([state, held, total]));

    opened[0].handlers.onClosed();
    expect(said).toEqual([["unavailable", 0, 2]]);

    // The retry is where a narrating runner would repeat itself, and the dedupe is
    // what keeps one unreadable screen from being the report.
    vi.advanceTimersByTime(60_000);
    opened[opened.length - 1].handlers.onClosed();
    expect(said).toEqual([["unavailable", 0, 2]]);

    // And the other direction, because a state that cannot be left is a state that
    // has replaced the report rather than made it: a dial that works says so.
    vi.advanceTimersByTime(60_000);
    const live = opened[opened.length - 1];
    live.handlers.onOpen();
    for (const join of joinsOf(live)) replyTo(live, join, "ok");
    expect(said[said.length - 1]).toEqual(["listening", 2, 2]);
    handle.close();
  });

  // The close a run ends with is not news about the connection, and the socket
  // answers it with the same `onClosed` a dropped one does: a real WebSocket fires
  // `close` after `close()` is called on it. Reporting that puts *the connection
  // dropped, work arrives by poll* on screen as the last thing a person reads,
  // about a runner that stopped on purpose.
  it("117-S30: says nothing about a socket it closed itself", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const said: ListeningState[] = [];
    const handle = open([BRAIN], () => {}, factory, (state) => said.push(state));
    opened[0].handlers.onOpen();
    for (const join of joinsOf(opened[0])) replyTo(opened[0], join, "ok");
    expect(said).toEqual(["listening"]);

    handle.close();
    opened[0].handlers.onClosed();
    expect(said).toEqual(["listening"]);
  });

  // And the other half of the same rule, which the retained answers hide: a
  // re-dial owes its own verdict, so one room answered out of two while the second
  // is still in flight is not *partial* yet.
  it("117-S31: a re-dial does not report on the connection that ended", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const said: Array<[ListeningState, number, number]> = [];
    const handle = open([BRAIN, OTHER], () => {}, factory, (state, held, total) => said.push([state, held, total]));
    opened[0].handlers.onOpen();
    for (const join of joinsOf(opened[0])) replyTo(opened[0], join, "ok");
    opened[0].handlers.onClosed();
    expect(said).toEqual([
      ["listening", 2, 2],
      ["retrying", 0, 2],
    ]);

    vi.advanceTimersByTime(60_000);
    const next = opened[opened.length - 1];
    next.handlers.onOpen();
    const joins = joinsOf(next);
    replyTo(next, joins[0], "ok");
    expect(said[said.length - 1]).toEqual(["retrying", 0, 2]);
    replyTo(next, joins[1], "ok");
    expect(said[said.length - 1]).toEqual(["listening", 2, 2]);
    handle.close();
  });

  it("listens to nothing, and opens nothing, for a runner with no brains", () => {
    const { opened, factory } = fakeSockets();
    const handle = open([], () => {}, factory);
    expect(opened).toHaveLength(0);
    handle.refresh("token-2");
    handle.close();
  });

  it("closes on demand and does not dial again after it", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const handle = open([BRAIN], () => {}, factory);
    opened[0].handlers.onOpen();
    handle.close();
    expect(opened[0].closed).toBe(true);
    opened[0].handlers.onClosed();
    vi.advanceTimersByTime(60_000);
    expect(opened).toHaveLength(1);
  });

  it("a runtime with no WebSocket is a runner that polls, not one that fails", () => {
    let signals = 0;
    const handle = open([BRAIN], () => (signals += 1), () => null);
    handle.refresh("token-2");
    handle.close();
    expect(signals).toBe(0);
  });
});
