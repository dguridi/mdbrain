// The socket that listens for work, beside the one that publishes presence.
//
// The impure edge for landing 2, built on the same wire as `realtime.ts` and
// deliberately not folded into it. The two hold different things for different
// reasons: a presence socket joins a brain's roster only while an agent is
// actually working there, and a listening socket has to be joined to every brain
// from startup — precisely while nothing is running, which is when a signal is
// worth having. One object doing both would have to be in a topic it is not in
// and leave a topic it must not leave.
//
// **Nothing here can end the run, and nothing here claims anything.** A signal
// causes a read; the read is the poll loop's, the cursor is still authoritative,
// and a socket that never connects costs the latency of one poll interval. That
// is the whole safety property, and it is why every failure below turns into
// silence rather than into an error the runner acts on.

import {
  accessTokenFrame,
  backoffDelay,
  broadcastIn,
  channels,
  decodeFrame,
  encodeFrame,
  heartbeatFrame,
  HEARTBEAT_MS,
  listenFrame,
  realtimeTopic,
  replyIn,
  aggregateListening,
  EVENTS,
  type ListeningState,
} from "./channel.ts";
// The socket factory comes from `realtime.ts` rather than being a second
// `new WebSocket` here: how a socket is opened, and what happens when a runtime
// has none, is one decision and a program with two links should not hold two
// answers to it.
import { openWebSocket, type SocketFactory } from "./realtime.ts";
import { signalDelayMs } from "./signal.ts";

/** What the listening link needs to exist. */
export interface SignalLinkOptions {
  url: string;
  /** The token to dial with, replaced by `refresh` for the life of the run. */
  accessToken: string;
  /** The brains to listen to. Empty means there is nothing to listen for. */
  brains: readonly string[];
  /**
   * Told once per delivered signal, with how long that signal asked the runner to
   * wait before reading. Zero means now, and is what every unreadable payload
   * comes back as.
   */
  onSignal: (dueInMs: number) => void;
  /**
   * Told when the aggregate state changes, and only then.
   *
   * Deduped for the reason the presence link dedupes its own: the alternative is
   * a runner narrating every attempt of a socket retrying against a network that
   * is down, which is precisely when a person is least able to read anything
   * else on the screen.
   */
  onState?: (state: ListeningState, held: number, total: number) => void;
  random: () => number;
  openSocket?: SocketFactory;
}

/** The runner's listening connection. */
export interface SignalLink {
  /** Hand every joined topic a fresher token, which the runner has each poll. */
  refresh(accessToken: string): void;
  /** Close the socket. The run is over and nothing may outlive it. */
  close(): void;
}

/** A link that listens to nothing, for a runner with no brains to watch. */
export const silentSignals: SignalLink = {
  refresh() {},
  close() {},
};

/**
 * Open the runner's listening connection.
 *
 * **One socket for every brain**, which is the opposite of the presence link and
 * for the same underlying reason: a Phoenix socket refuses nothing about *two
 * different* topics and breaks only on two live joins of *one* topic. The work
 * topics are distinct by construction, so they share a socket, and a runner
 * listening to nine brains holds one connection rather than nine.
 *
 * **A join that fails is asked again, and a room the server takes away is
 * rejoined.** The reason a join is refused is not reliably a policy or a topic
 * name: the commonest one is an access token that has aged out, and that does
 * answer differently for being asked again once a fresher one is to hand. Giving
 * up on the first refusal left no way back — the socket stays open and keeps
 * answering heartbeats, so nothing re-dials it and nothing notices, and the
 * runner goes deaf while every surface still reports a healthy connection. The
 * retry is per topic and on the shared backoff, so one brain's refusal costs that
 * brain's signals and never another's.
 */
export function signalLink(options: SignalLinkOptions): SignalLink {
  if (options.brains.length === 0) return silentSignals;
  const openSocket = options.openSocket ?? openWebSocket;
  const topics = [...new Set(options.brains)].map((id) => channels.work(id));
  const wire = new Set(topics.map((topic) => realtimeTopic(topic)));

  let accessToken = options.accessToken;
  let handle: ReturnType<SocketFactory> = null;
  let open = false;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let refs = 0;
  const nextRef = () => String(++refs);
  /** Topic by the ref its join was sent under, so a refusal can be attributed. */
  const joining = new Map<string, string>();
  /** The joins that were accepted, which is what `refresh` has to re-authorise. */
  const joined = new Map<string, string>();
  /** Pending rejoins, by topic, so one brain's backoff never delays another's. */
  const rejoinTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Consecutive refusals per topic, which is what paces that topic's backoff. */
  const rejoinAttempts = new Map<string, number>();
  /** The topic a wire name belongs to, so a frame about a room can be attributed. */
  const byWire = new Map(topics.map((topic) => [realtimeTopic(topic), topic]));
  /** Topics whose first join has been answered, which is what `settled` counts. */
  const answered = new Set<string>();
  /** Whether the socket has ever been usable, separating down from never up. */
  let everOpen = false;
  /**
   * Whether the dial in hand has resolved as a failure.
   *
   * **A close resolves a first attempt as surely as an open does**, which is the
   * rule the presence link keeps in the field it calls `settled`: without it a
   * handshake that is refused — `error` then `close`, and never `onOpen` — reads
   * as an attempt still in flight, and an attempt in flight is deliberately not
   * reported, so the one failure the reader most needs is the one never said.
   * Reset on each dial rather than kept, because what it settles is this
   * connection's verdict and a re-dial owes its own.
   */
  let dialClosed = false;
  /** The state already reported, so an unchanged aggregate says nothing. */
  let said: ListeningState | null = null;

  /**
   * Report where the socket stands, if that has changed.
   *
   * Called from every place the aggregate can move rather than on a timer, so
   * the line on screen is a consequence of something that happened rather than a
   * poll of a value that mostly does not change.
   */
  const sayState = () => {
    // **A socket this closed itself is not news**, and it arrives here as the same
    // `onClosed` a dropped one does, because a WebSocket fires `close` in answer to
    // `close()`. Without this the last thing a person reads about a runner they
    // stopped on purpose is that its connection dropped. The presence link has
    // carried this guard from the start; the rule is the same one.
    if (closed) return;
    if (options.onState === undefined) return;
    const settled = answered.size >= topics.length || dialClosed || handle === null;
    const state = aggregateListening({ held: joined.size, total: topics.length, everOpen, settled });
    if (state === null || state === said) return;
    said = state;
    options.onState(state, joined.size, topics.length);
  };

  const send = (frame: Parameters<typeof encodeFrame>[0]) => {
    if (!open || handle === null) return;
    handle.send(encodeFrame(frame));
  };

  const stopRejoins = () => {
    for (const timer of rejoinTimers.values()) clearTimeout(timer);
    rejoinTimers.clear();
    rejoinAttempts.clear();
  };

  const stopTimers = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    retryTimer = null;
    heartbeatTimer = null;
    stopRejoins();
  };

  /**
   * Ask for one topic, under a fresh ref so its reply can be attributed.
   *
   * Any pending rejoin for that topic is dropped first, because the join being
   * sent now is the one whose answer matters and a timer still holding the old
   * attempt would ask a second time for a room already being joined.
   */
  const joinTopic = (topic: string) => {
    // **Never a second live join of one topic on one socket, and this is the only
    // place that can promise it.** Realtime does not refuse the duplicate: it
    // answers the newcomer `ok` and closes the incumbent, and the close frame
    // names only the topic — no ref, empty payload — so the handler below cannot
    // tell *the room I hold is gone* from *a duplicate I made was evicted*. Read
    // as the first, it rejoins, which evicts the join it already had, which
    // closes, which rejoins: a room that is actually held, churning for the life
    // of the process with every signal still arriving and nothing to see. The
    // window is real rather than theoretical — `refresh` asks for every room it
    // is not in, and at startup that lands within a round trip of the joins
    // `onOpen` has just sent.
    for (const inFlight of joining.values()) if (inFlight === topic) return;
    const pending = rejoinTimers.get(topic);
    if (pending !== undefined) {
      clearTimeout(pending);
      rejoinTimers.delete(topic);
    }
    const ref = nextRef();
    joining.set(ref, topic);
    send(listenFrame(topic, accessToken, ref));
  };

  /**
   * Ask for a topic again, later.
   *
   * **Per topic rather than per socket**, because the socket is not what failed:
   * one room was refused, and tearing down a working connection to recover it
   * would cost every other brain its signals for the length of a backoff.
   */
  const scheduleRejoin = (topic: string) => {
    if (closed || rejoinTimers.has(topic)) return;
    const attempt = (rejoinAttempts.get(topic) ?? 0) + 1;
    rejoinAttempts.set(topic, attempt);
    const timer = setTimeout(() => {
      rejoinTimers.delete(topic);
      if (closed || !open) return;
      joinTopic(topic);
    }, backoffDelay(attempt, options.random()));
    timer.unref?.();
    rejoinTimers.set(topic, timer);
  };

  const dial = () => {
    if (closed) return;
    joining.clear();
    joined.clear();
    dialClosed = false;
    handle = openSocket(options.url, {
      onOpen() {
        open = true;
        everOpen = true;
        attempt = 0;
        // Unref'd so a heartbeat can never be the reason this process refuses to
        // exit; the run's last line closes the socket anyway.
        heartbeatTimer = setInterval(() => send(heartbeatFrame(nextRef())), HEARTBEAT_MS);
        heartbeatTimer.unref?.();
        for (const topic of topics) joinTopic(topic);
      },
      onMessage(text) {
        const frame = decodeFrame(text);
        if (frame === null) return;
        const reply = replyIn(frame);
        if (reply !== null) {
          const topic = joining.get(reply.ref);
          if (topic === undefined) return;
          joining.delete(reply.ref);
          answered.add(topic);
          if (reply.ok) {
            joined.set(topic, reply.ref);
            rejoinAttempts.delete(topic);
          } else {
            joined.delete(topic);
            scheduleRejoin(topic);
          }
          sayState();
          return;
        }
        // **A room the server closes under us is the case nothing else sees.** An
        // access token ageing out does not drop the connection: the socket stays
        // up and goes on answering heartbeats while the room it was holding is
        // gone, so neither the reply path above nor `onClosed` below is ever
        // reached. Reading the frame that says so is the whole of what turns that
        // from permanent silence into a rejoin.
        if (frame.event === "phx_error" || frame.event === "phx_close") {
          const closedTopic = byWire.get(frame.topic);
          if (closedTopic === undefined) return;
          joined.delete(closedTopic);
          scheduleRejoin(closedTopic);
          sayState();
          return;
        }
        const broadcast = broadcastIn(frame);
        if (broadcast === null) return;
        // The topic is checked as well as the event, because one socket now holds
        // several rooms and a frame is only evidence about the room it came from.
        if (!wire.has(frame.topic)) return;
        if (broadcast.event !== EVENTS.workArrived) return;
        // **The one thing read out of a signal, and it names nothing.** The delay
        // is derived from the row's own timestamps and the schema's constants, so
        // it is not a copy of state that has to be kept in step and it discloses
        // no file, claim or body. What it buys is the moment a session becomes
        // claimable, which has no write of its own to announce it.
        options.onSignal(signalDelayMs(broadcast.payload));
      },
      onClosed() {
        open = false;
        dialClosed = true;
        joining.clear();
        joined.clear();
        // The rooms are gone with the socket, so what was answered about them is
        // no longer an answer: a re-dial has to settle them again before this
        // reports on the new connection rather than on the one that just ended.
        answered.clear();
        stopTimers();
        sayState();
        if (closed) return;
        attempt += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          dial();
        }, backoffDelay(attempt, options.random()));
        retryTimer.unref?.();
      },
    });
    if (handle === null) {
      // No WebSocket in this runtime. Nothing to retry: the poll is the whole of
      // how this runner finds work, exactly as it was before signalling existed.
      open = false;
      sayState();
    }
  };

  dial();

  return {
    refresh(token) {
      accessToken = token;
      for (const [topic, joinRef] of joined) {
        send(accessTokenFrame(topic, token, nextRef(), joinRef));
      }
      // **The rooms that are not held are asked for again at once**, and this is
      // the half that recovers a runner rather than merely keeping a healthy one
      // healthy. A fresher token is precisely the thing that makes a refusal
      // answer differently, so waiting out a backoff paced for a policy refusal
      // would leave the runner deaf with the remedy already in hand.
      if (!open) return;
      for (const topic of topics) {
        if (!joined.has(topic)) joinTopic(topic);
      }
    },
    close() {
      closed = true;
      stopTimers();
      handle?.close();
      handle = null;
      open = false;
    },
  };
}
