import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_CEILING_MS,
  EVENTS,
  aggregateConnection,
  backoffDelay,
  broadcastIn,
  channels,
  connectionText,
  decodeFrame,
  encodeFrame,
  heartbeatFrame,
  HEARTBEAT_MS,
  replyIn,
  socketUrl,
  type Frame,
} from "../src/run/channel.ts";
import {
  PRESENCE_LINGER_MS,
  desiredPresence,
  emptyLedger,
  presenceKeyFor,
  presencePayload,
  reconcile,
  type PresenceLedger,
} from "../src/run/presence.ts";
import { openWebSocket, presenceLink, type SocketFactory, type SocketHandlers } from "../src/run/realtime.ts";
import { colorForBot } from "@markdown-den/collab-core";

const BRAIN = "brain-1";
const OTHER = "brain-2";
const TOPIC = channels.workspacePresence(BRAIN);

interface FakeSocket {
  url: string;
  handlers: SocketHandlers;
  sent: string[];
  closed: boolean;
  send(text: string): void;
  close(): void;
}

/** Every socket the link opened, and the handlers to drive each one with. */
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

const broadcastsOf = (socket: FakeSocket) =>
  framesOf(socket)
    .map((frame) => {
      const payload = frame.payload as { type?: string; event?: string; payload?: unknown };
      return frame.event === "broadcast" ? { event: payload.event, payload: payload.payload } : null;
    })
    .filter((sent): sent is { event: string | undefined; payload: unknown } => sent !== null);

/**
 * Answer the join the way the server actually does.
 *
 * **The reply carries no `join_ref`, and that is not an omission.** The 1.0.0
 * serializer sends the server's frames with `topic`, `ref`, `event` and
 * `payload` and nothing else, so a client that insisted on a `join_ref` would
 * never recognise its own join being accepted — and would sit open on a channel
 * it never finished joining, present to nobody. Writing the reply exactly as it
 * arrives is what keeps that from passing here and failing in production.
 */
function replyToJoin(socket: FakeSocket, status: "ok" | "error" = "ok") {
  const join = framesOf(socket).find((frame) => frame.event === "phx_join");
  expect(join).toBeDefined();
  socket.handlers.onMessage(
    JSON.stringify({ topic: join!.topic, ref: join!.ref, event: "phx_reply", payload: { status, response: {} } }),
  );
}

function link(over: Partial<Parameters<typeof presenceLink>[0]>, factory: SocketFactory) {
  const states: string[] = [];
  return {
    states,
    handle: presenceLink({
      url: "wss://example.test/realtime/v1/websocket",
      accessToken: "token-1",
      identities: new Map([["dev-bot", { userId: "u-1", name: "dev-bot" }]]),
      nonce: "nonce",
      onState: (state) => states.push(state),
      now: () => Date.now(),
      random: () => 0,
      openSocket: factory,
      ...over,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the wire the runner speaks", () => {
  it("dials the project's Realtime socket with the anon key and a version it names", () => {
    const url = socketUrl("https://project.supabase.co/", "anon-key");
    expect(url).toBe("wss://project.supabase.co/realtime/v1/websocket?apikey=anon-key&vsn=1.0.0");
  });

  it("round-trips a frame, and answers null for anything that is not one", () => {
    const frame = heartbeatFrame("7");
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    expect(decodeFrame("not json")).toBeNull();
    expect(decodeFrame("[1,2,3]")).toBeNull();
    expect(decodeFrame(JSON.stringify({ topic: 1 }))).toBeNull();
  });

  it("reads a reply that carries no join_ref, which is every reply this server sends", () => {
    // The whole of the regression: 1.0.0 drops join_ref from a server frame, so
    // a rule that required one would recognise nothing.
    const decoded = decodeFrame(
      JSON.stringify({ topic: "realtime:t", ref: "1", event: "phx_reply", payload: { status: "ok", response: {} } }),
    );
    expect(decoded!.join_ref).toBeNull();
    expect(replyIn(decoded!)).toEqual({ ref: "1", ok: true });

    const refused = decodeFrame(
      JSON.stringify({ topic: "realtime:t", ref: "1", event: "phx_reply", payload: { status: "error", response: {} } }),
    );
    expect(replyIn(refused!)).toEqual({ ref: "1", ok: false });
    // Anything that is not a reply, and a reply nobody can attribute.
    expect(replyIn({ topic: "realtime:t", event: "broadcast", payload: {}, ref: "1", join_ref: null })).toBeNull();
    expect(replyIn({ topic: "realtime:t", event: "phx_reply", payload: {}, ref: null, join_ref: null })).toBeNull();
  });

  it("unwraps the event name a broadcast carries inside its envelope", () => {
    expect(
      broadcastIn({
        topic: "realtime:t",
        event: "broadcast",
        payload: { type: "broadcast", event: EVENTS.syncRequest, payload: {} },
        ref: null,
        join_ref: null,
      }),
    ).toEqual({ topic: "realtime:t", event: EVENTS.syncRequest, payload: {} });
    expect(broadcastIn({ topic: "realtime:t", event: "phx_reply", payload: {}, ref: null, join_ref: null })).toBeNull();
  });
});

describe("117-S2: a dropped connection is retried with a bounded, jittered backoff", () => {
  it("grows to a ceiling and never past it", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((attempt) => backoffDelay(attempt, 1));
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(BACKOFF_CEILING_MS);
    expect(delays.at(-1)).toBe(BACKOFF_CEILING_MS);
  });

  it("puts no two runners on the same schedule", () => {
    // The whole point of the jitter: every runner on one flaky network drops at
    // the same moment, and a fixed delay would bring them all back together.
    const drawn = new Set([0, 0.25, 0.5, 0.75, 0.99].map((random) => backoffDelay(5, random)));
    expect(drawn.size).toBe(5);
    for (const delay of drawn) expect(delay).toBeGreaterThan(0);
  });

  it("waits the backoff and dials again, rather than giving up on the first drop", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const { handle } = link({ random: () => 0.5 }, factory);
    opened[0].handlers.onOpen();
    opened[0].handlers.onClosed();
    expect(opened).toHaveLength(1);
    vi.advanceTimersByTime(backoffDelay(1, 0.5) + 1);
    expect(opened).toHaveLength(2);
    handle.close();
  });
});

describe("117-S1: a connection that cannot be made does not stop the run", () => {
  it("says presence is unavailable once, and only once, when no socket can be opened", () => {
    const { states, handle } = link({}, () => null);
    expect(states).toEqual(["unavailable"]);
    // Nothing throws, and asking for presence on a link with no socket is a
    // no-op rather than a failure.
    handle.want(new Map([["dev-bot", BRAIN]]));
    handle.refresh("token-2");
    handle.close();
    expect(states).toEqual(["unavailable"]);
  });

  it("says nothing at all while the first attempt is still in flight", () => {
    // The line a person acts on must not appear on every healthy startup for as
    // long as a handshake takes.
    const { opened, factory } = fakeSockets();
    const { states, handle } = link({}, factory);
    expect(states).toEqual([]);
    opened[0].handlers.onOpen();
    expect(states).toEqual(["connected"]);
    handle.close();
  });

  it("distinguishes a connection that never worked from one that worked a moment ago", () => {
    const dialling = { open: false, everOpen: false, settled: false };
    const failed = { open: false, everOpen: false, settled: true };
    const dropped = { open: false, everOpen: true, settled: true };
    const up = { open: true, everOpen: true, settled: true };
    expect(aggregateConnection([])).toBeNull();
    expect(aggregateConnection([dialling])).toBeNull();
    expect(aggregateConnection([failed])).toBe("unavailable");
    expect(aggregateConnection([dropped])).toBe("retrying");
    expect(aggregateConnection([up, up])).toBe("connected");
    expect(aggregateConnection([up, failed])).toBe("retrying");
    // Every sentence names what is still true, since it is read while somebody
    // is deciding whether the runner is working at all.
    expect(connectionText("unavailable")).toContain("work still arrives by poll");
    expect(connectionText("retrying")).toContain("work still arrives by poll");
  });
});

describe("117-S5, 117-S6, 117-S7: presence follows the stretch, not the unit", () => {
  const flags = (running: boolean, workspace: string | null) => new Map([["dev-bot", { running, workspace }]]);

  it("117-S5: an agent working through a queue does not leave the roster between units", () => {
    // Asserted on the flag's own transitions, because the event pair has a real
    // gap and the flag does not: between two queued units the flag goes false
    // and true again in the same microtask.
    let ledger: PresenceLedger = emptyLedger;
    const first = reconcile(ledger, desiredPresence(flags(true, BRAIN)), 0);
    ledger = first.ledger;
    expect(first.actions).toEqual([{ kind: "join", agent: "dev-bot", workspace: BRAIN }]);

    // Unit one ends and unit two starts. The flag flips twice with nothing
    // awaited between, but the wall clock is free to tick — so the second
    // reading is deliberately a millisecond later than the first. A linger that
    // did not outlast that millisecond would drop the session here, which is
    // the whole failure this scenario exists to prevent.
    const between = reconcile(ledger, desiredPresence(flags(false, null)), 1_000);
    ledger = between.ledger;
    const next = reconcile(ledger, desiredPresence(flags(true, BRAIN)), 1_001);
    ledger = next.ledger;
    expect(between.actions).toEqual([]);
    expect(next.actions).toEqual([]);

    // And it is still standing well past when the linger would have run out.
    const later = reconcile(ledger, desiredPresence(flags(true, BRAIN)), 1_000 + PRESENCE_LINGER_MS * 10);
    expect(later.actions).toEqual([]);
  });

  it("117-S6: three units are one entry for the whole run rather than three", () => {
    let ledger: PresenceLedger = emptyLedger;
    const joins: unknown[] = [];
    let at = 0;
    for (let unit = 0; unit < 3; unit++) {
      // A millisecond after the previous unit ended, for the reason above.
      at += 1;
      const started = reconcile(ledger, desiredPresence(flags(true, BRAIN)), at);
      ledger = started.ledger;
      joins.push(...started.actions);
      at += 60_000;
      const ended = reconcile(ledger, desiredPresence(flags(false, null)), at);
      ledger = ended.ledger;
      joins.push(...ended.actions);
    }
    expect(joins).toEqual([{ kind: "join", agent: "dev-bot", workspace: BRAIN }]);
  });

  it("117-S7: the linger is a real window rather than a nominal one", () => {
    // Stated as its own assertion because every scenario here is written in
    // terms of the constant, and a linger of zero would satisfy all of them
    // while breaking the one thing they are collectively about.
    expect(PRESENCE_LINGER_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("117-S7: it leaves after the linger, and a unit arriving inside it leaves the session standing", () => {
    let ledger = reconcile(emptyLedger, desiredPresence(flags(true, BRAIN)), 0).ledger;
    const ended = reconcile(ledger, desiredPresence(flags(false, null)), 100);
    ledger = ended.ledger;
    expect(ended.actions).toEqual([]);
    expect(ended.nextDeadline).toBe(100 + PRESENCE_LINGER_MS);

    const inside = reconcile(ledger, desiredPresence(flags(false, null)), 100 + PRESENCE_LINGER_MS - 1);
    expect(inside.actions).toEqual([]);

    const rescued = reconcile(inside.ledger, desiredPresence(flags(true, BRAIN)), 100 + PRESENCE_LINGER_MS - 1);
    expect(rescued.actions).toEqual([]);
    expect(reconcile(rescued.ledger, desiredPresence(flags(false, null)), 10_000_000).actions).toEqual([]);

    const expired = reconcile(inside.ledger, desiredPresence(flags(false, null)), 100 + PRESENCE_LINGER_MS);
    expect(expired.actions).toEqual([{ kind: "leave", agent: "dev-bot", workspace: BRAIN }]);
    expect(expired.ledger.size).toBe(0);
  });

  it("moves at once when the next unit is for a different brain, rather than lingering in the old one", () => {
    const ledger = reconcile(emptyLedger, desiredPresence(flags(true, BRAIN)), 0).ledger;
    const moved = reconcile(ledger, desiredPresence(flags(true, OTHER)), 10);
    expect(moved.actions).toEqual([
      { kind: "leave", agent: "dev-bot", workspace: BRAIN },
      { kind: "join", agent: "dev-bot", workspace: OTHER },
    ]);
  });

  it("reads nothing off an agent that is running for no brain", () => {
    expect(desiredPresence(flags(true, null)).size).toBe(0);
    expect(desiredPresence(flags(false, BRAIN)).size).toBe(0);
  });
});

describe("117-S10: both publishers derive the colour from the same function", () => {
  it("takes the colour from collab-core rather than picking one here", () => {
    const payload = presencePayload(presenceKeyFor("nonce", "u-1"), "u-1", "dev-bot");
    expect(payload.color).toBe(colorForBot("u-1"));
    expect(payload.isBot).toBe(true);
  });

  it("117-S8: publishes no file, which is what keeps the agent off the file tree", () => {
    expect(presencePayload("k", "u-1", "dev-bot").activeFileId).toBeNull();
  });

  it("keys one runner's session apart from another running the same agent", () => {
    expect(presenceKeyFor("a", "u-1")).not.toBe(presenceKeyFor("b", "u-1"));
    expect(presenceKeyFor("a", "u-1")).toBe(presenceKeyFor("a", "u-1"));
  });
});

describe("the link, joining and publishing", () => {
  it("119-S13: joins the brain's presence topic privately, with its own token, tracks membership, and broadcasts who it is", () => {
    const { opened, factory } = fakeSockets();
    const { handle } = link({}, factory);
    opened[0].handlers.onOpen();
    handle.want(new Map([["dev-bot", BRAIN]]));

    const join = framesOf(opened[0]).find((frame) => frame.event === "phx_join");
    expect(join?.topic).toBe(`realtime:${TOPIC}`);
    expect(join?.payload).toMatchObject({
      access_token: "token-1",
      config: { presence: { key: presenceKeyFor("nonce", "u-1"), enabled: true }, private: true },
    });

    replyToJoin(opened[0]);
    const track = framesOf(opened[0]).find((frame) => frame.event === "presence");
    expect(track?.payload).toEqual({ type: "presence", event: "track", payload: {} });
    expect(broadcastsOf(opened[0])).toEqual([
      { event: EVENTS.activeFile, payload: presencePayload(presenceKeyFor("nonce", "u-1"), "u-1", "dev-bot") },
    ]);
    handle.close();
  });

  it("answers a joiner's sync-request, because broadcast carries no snapshot of its own", () => {
    const { opened, factory } = fakeSockets();
    const { handle } = link({}, factory);
    opened[0].handlers.onOpen();
    handle.want(new Map([["dev-bot", BRAIN]]));
    replyToJoin(opened[0]);
    opened[0].handlers.onMessage(
      encodeFrame({
        topic: `realtime:${TOPIC}`,
        event: "broadcast",
        payload: { type: "broadcast", event: EVENTS.syncRequest, payload: {} },
        ref: null,
        join_ref: null,
      }),
    );
    expect(broadcastsOf(opened[0])).toHaveLength(2);
    handle.close();
  });

  it("117-S12: nothing is re-broadcast on a timer", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const { handle } = link({}, factory);
    opened[0].handlers.onOpen();
    handle.want(new Map([["dev-bot", BRAIN]]));
    replyToJoin(opened[0]);
    expect(broadcastsOf(opened[0])).toHaveLength(1);

    // An hour present, with no unit starting or ending.
    vi.advanceTimersByTime(60 * 60 * 1_000);
    expect(broadcastsOf(opened[0])).toHaveLength(1);
    // What the hour did produce is heartbeats, which go to the socket itself and
    // are not billed per subscriber the way a broadcast is.
    const beats = framesOf(opened[0]).filter((frame) => frame.event === "heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(60 * 60 * 1_000 / HEARTBEAT_MS - 1);
    handle.close();
  });

  it("hands a joined topic the fresher token the poll just refreshed", () => {
    const { opened, factory } = fakeSockets();
    const { handle } = link({}, factory);
    opened[0].handlers.onOpen();
    handle.want(new Map([["dev-bot", BRAIN]]));
    replyToJoin(opened[0]);
    handle.refresh("token-2");
    const sent = framesOf(opened[0]).find((frame) => frame.event === "access_token");
    expect(sent?.payload).toEqual({ access_token: "token-2" });
    handle.close();
  });

  it("leaves the roster once the linger has run out, on its own timer", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const { handle } = link({}, factory);
    opened[0].handlers.onOpen();
    handle.want(new Map([["dev-bot", BRAIN]]));
    replyToJoin(opened[0]);
    handle.want(new Map());
    expect(framesOf(opened[0]).some((frame) => frame.event === "phx_leave")).toBe(false);
    vi.advanceTimersByTime(PRESENCE_LINGER_MS + 1);
    expect(framesOf(opened[0]).some((frame) => frame.event === "phx_leave")).toBe(true);
    handle.close();
  });

  it("a refused join is an open socket that is useless, and the state says so", () => {
    // The transport is fine and the channel is not, which is one failure with
    // two halves. Reporting *connected* about it would be the screen saying the
    // one thing that is comfortably false: nothing will ever reach a roster.
    const { opened, factory } = fakeSockets();
    const { states, handle } = link({}, factory);
    opened[0].handlers.onOpen();
    expect(states).toEqual(["connected"]);
    handle.want(new Map([["dev-bot", BRAIN]]));
    replyToJoin(opened[0], "error");
    expect(states).toEqual(["connected", "unavailable"]);
    // And nothing was tracked or broadcast on a channel that refused us.
    expect(framesOf(opened[0]).some((frame) => frame.event === "presence")).toBe(false);
    expect(broadcastsOf(opened[0])).toEqual([]);
    handle.close();
  });

  it("stops being pessimistic once a later join is accepted", () => {
    const { opened, factory } = fakeSockets();
    const { states, handle } = link({}, factory);
    opened[0].handlers.onOpen();
    handle.want(new Map([["dev-bot", BRAIN]]));
    replyToJoin(opened[0], "error");
    // A policy that changes is picked up by the next attempt rather than leaving
    // the runner permanently claiming presence is unavailable.
    handle.want(new Map([["dev-bot", OTHER]]));
    replyToJoin(opened[0], "ok");
    expect(states.at(-1)).toBe("connected");
    handle.close();
  });

  it("117-S11: a killed runner disappears without anything expiring it", () => {
    // Nothing here withdraws the entry: the socket dies, the server's own
    // heartbeat notices, and the browser's existing reconcile pass removes the
    // session after its grace window. There is no sweep, no timer and no new
    // code — which is exactly what closing without a leave frame asserts.
    const { opened, factory } = fakeSockets();
    const { handle } = link({}, factory);
    opened[0].handlers.onOpen();
    handle.want(new Map([["dev-bot", BRAIN]]));
    replyToJoin(opened[0]);
    handle.close();
    expect(opened[0].closed).toBe(true);
    expect(framesOf(opened[0]).some((frame) => frame.event === "phx_leave")).toBe(false);
  });

  it("117-S3: a closed link stops dialling and stops saying anything", () => {
    vi.useFakeTimers();
    const { opened, factory } = fakeSockets();
    const { states, handle } = link({}, factory);
    opened[0].handlers.onOpen();
    handle.close();
    opened[0].handlers.onClosed();
    vi.advanceTimersByTime(BACKOFF_CEILING_MS * 10);
    expect(opened).toHaveLength(1);
    expect(states).toEqual(["connected"]);
  });

  it("opens one connection per agent, because a socket holds one join per topic", () => {
    const { opened, factory } = fakeSockets();
    const { handle } = link(
      {
        identities: new Map([
          ["dev-bot", { userId: "u-1", name: "dev-bot" }],
          ["critic", { userId: "u-2", name: "critic" }],
        ]),
      },
      factory,
    );
    expect(opened).toHaveLength(2);
    for (const socket of opened) socket.handlers.onOpen();
    handle.want(
      new Map([
        ["dev-bot", BRAIN],
        ["critic", BRAIN],
      ]),
    );
    // Two entries in one brain's roster, under two presence keys.
    const keys = opened.map((socket) => {
      const join = framesOf(socket).find((frame) => frame.event === "phx_join");
      return (join?.payload as { config: { presence: { key: string } } }).config.presence.key;
    });
    expect(new Set(keys).size).toBe(2);
    handle.close();
  });
});

describe("the socket the runner opens when nothing stands one in", () => {
  /** The runtime's `WebSocket`, reduced to what `openWebSocket` touches. */
  class FakeWebSocket {
    static made: FakeWebSocket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    sent: string[] = [];
    closed = false;
    /** Set to make `send` throw, which is what a socket closing under us does. */
    throwOnSend = false;
    constructor(readonly url: string) {
      FakeWebSocket.made.push(this);
    }
    send(text: string) {
      if (this.throwOnSend) throw new Error("the socket went away mid-send");
      this.sent.push(text);
    }
    close() {
      this.closed = true;
    }
  }

  const stubWebSocket = () => {
    FakeWebSocket.made = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    return FakeWebSocket;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a refused handshake's error and its close as one drop rather than two", () => {
    // The two are not the same event and either can be the only one that
    // arrives: a handshake refused fires `error` and then `close`, a connection
    // dropped mid-life fires `close` alone.
    stubWebSocket();
    let closes = 0;
    openWebSocket("wss://example.test", { onOpen() {}, onMessage() {}, onClosed: () => { closes += 1; } });
    const socket = FakeWebSocket.made[0];
    socket.onerror!();
    socket.onclose!();
    expect(closes).toBe(1);

    // And a drop with no error before it is still a drop, which is the half a
    // de-dup could plausibly have swallowed.
    let alone = 0;
    openWebSocket("wss://example.test", { onOpen() {}, onMessage() {}, onClosed: () => { alone += 1; } });
    FakeWebSocket.made[1].onclose!();
    expect(alone).toBe(1);
  });

  it("so one refused handshake costs one step of the backoff, not two", () => {
    // The consequence, and it is what makes the flag above more than tidiness:
    // the retry timer is cleared and rearmed on each read, so a refusal read
    // twice does not dial twice — it advances the attempt counter twice, and the
    // backoff reaches its ceiling in half the drops. Asserted by advancing to
    // exactly the FIRST step's delay: a socket that took two steps is still
    // waiting there.
    vi.useFakeTimers();
    stubWebSocket();
    const { handle } = link({ random: () => 0.5, openSocket: openWebSocket }, () => null);
    expect(FakeWebSocket.made).toHaveLength(1);

    const socket = FakeWebSocket.made[0];
    socket.onopen!();
    socket.onerror!();
    socket.onclose!();
    expect(backoffDelay(2, 0.5)).toBeGreaterThan(backoffDelay(1, 0.5));
    vi.advanceTimersByTime(backoffDelay(1, 0.5) + 1);
    expect(FakeWebSocket.made).toHaveLength(2);
    handle.close();
  });

  it("hands on the text frames and ignores anything that is not text", () => {
    stubWebSocket();
    const heard: string[] = [];
    openWebSocket("wss://example.test", { onOpen() {}, onMessage: (t) => heard.push(t), onClosed() {} });
    const socket = FakeWebSocket.made[0];
    socket.onmessage!({ data: "a frame" });
    socket.onmessage!({ data: new ArrayBuffer(4) });
    expect(heard).toEqual(["a frame"]);
  });

  it("a send into a socket that went away is not a throw somebody upstream has to catch", () => {
    stubWebSocket();
    const handle = openWebSocket("wss://example.test", { onOpen() {}, onMessage() {}, onClosed() {} });
    const socket = FakeWebSocket.made[0];
    socket.throwOnSend = true;
    expect(() => handle!.send("anything")).not.toThrow();
    expect(() => handle!.close()).not.toThrow();
    expect(socket.closed).toBe(true);
  });

  it("answers null in a runtime with no WebSocket at all, rather than crashing the run", () => {
    vi.stubGlobal("WebSocket", undefined);
    expect(openWebSocket("wss://example.test", { onOpen() {}, onMessage() {}, onClosed() {} })).toBeNull();
  });
});
