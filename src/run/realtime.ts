// The socket itself: dial, hold, reconnect, and carry out what the presence
// ledger decided.
//
// The impure edge beside `channel.ts` and `presence.ts`, which are the wire and
// the decision. Everything here is a WebSocket, a timer or a random number, and
// nothing here decides when an agent should be present or what a frame looks
// like — so the two things most likely to be wrong stay assertable without a
// network.
//
// **A connection is per agent, and that is Realtime's constraint rather than a
// preference.** A Phoenix socket holds one *live* join per topic; two agents
// running in the same brain at the same time are two entries in that brain's
// roster, under two presence keys, which cannot be two live joins of one topic on
// one socket. The server does not refuse a duplicate join — it replies `ok` to the
// second and closes the first, in a frame naming only the topic, with no `ref` and
// an empty payload. So a shared socket would evict the first agent from the roster
// with nothing anywhere reporting it, which is why each configured agent gets its
// own connection rather than sharing one. What the runner says on screen
// is the aggregate of them, because a person watching wants to know whether
// presence is working, not which of four sockets is between attempts.
//
// **Nothing here can end the run.** A socket that will not connect is a degraded
// runner and not a stopped one: the poll is still there and still works, and
// every failure below turns into a state the runner says once. A connection
// failure that exited would be a regression against a program whose whole point
// is that it survives being left alone.

import {
  EVENTS,
  accessTokenFrame,
  aggregateConnection,
  backoffDelay,
  broadcastFrame,
  broadcastIn,
  channels,
  decodeFrame,
  encodeFrame,
  heartbeatFrame,
  HEARTBEAT_MS,
  joinFrame,
  leaveFrame,
  replyIn,
  realtimeTopic,
  trackFrame,
  type ConnectionState,
} from "./channel.ts";
import { emptyLedger, presenceKeyFor, presencePayload, reconcile, type PresenceLedger } from "./presence.ts";

/**
 * How long a join may go unanswered before it is treated as refused.
 *
 * Phoenix's own clients give a join ten seconds. Without a bound, a reply lost
 * on the way back leaves the join in flight for as long as the connection lasts,
 * and a join in flight is exactly what refuses every later ask — so one lost
 * frame would keep the agent out of the roster until the socket happened to drop.
 */
export const JOIN_TIMEOUT_MS = 10_000;

/** What a socket hands back, reduced to the two things this uses. */
export interface SocketHandle {
  send(text: string): void;
  close(): void;
}

/** What the link wants told, so a socket can be stood in without a network. */
export interface SocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClosed(): void;
}

/**
 * How a socket is opened.
 *
 * A parameter rather than a direct `new WebSocket`, because everything
 * interesting about this module is *when* it dials and what it sends, and a test
 * that had to stand up a Phoenix server to see any of it is a test nobody runs.
 * It answers null when this runtime has no WebSocket at all, which is a reason to
 * say presence is unavailable rather than to crash.
 */
export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle | null;

/** The default: the runtime's own WebSocket, or nothing where there is none. */
export const openWebSocket: SocketFactory = (url, handlers) => {
  if (typeof WebSocket === "undefined") return null;
  const socket = new WebSocket(url);
  let finished = false;
  const closed = () => {
    if (finished) return;
    finished = true;
    handlers.onClosed();
  };
  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (event) => {
    if (typeof event.data === "string") handlers.onMessage(event.data);
  };
  // Both, because the two are not the same event and either can be the only one
  // that arrives: a handshake refused fires `error` and then `close`, while a
  // connection dropped mid-life fires `close` alone. `finished` is what keeps
  // the pair from being read as two drops.
  socket.onerror = closed;
  socket.onclose = closed;
  return {
    send(text) {
      // A socket closing under us throws on send. There is nothing to do about
      // it: the close handler is already on its way and will schedule the
      // retry, and a throw here would escape into whatever asked for presence.
      try {
        socket.send(text);
      } catch {
        // Deliberately nothing.
      }
    },
    close() {
      try {
        socket.close();
      } catch {
        // Deliberately nothing.
      }
    },
  };
};

/** The identity a runner publishes for one configured agent. */
export interface AgentIdentity {
  /** `agents.bot_user_id` — the account the roster dedupes on. */
  userId: string;
  /** What the roster calls it, which is the agent's own display name. */
  name: string;
}

/** What the link needs to exist. */
export interface PresenceLinkOptions {
  url: string;
  /** The token to dial with. Replaced by `refresh` for the life of the run. */
  accessToken: string;
  /** By configured agent name, so a name with no identity is simply not published. */
  identities: ReadonlyMap<string, AgentIdentity>;
  /** This process's own nonce, so two runners of one agent are two sessions. */
  nonce: string;
  /** Said only when the aggregate changes, so a flapping socket is one line. */
  onState: (state: ConnectionState) => void;
  now: () => number;
  random: () => number;
  openSocket?: SocketFactory;
}

/**
 * The runner's presence connection.
 *
 * `want` is the only way presence changes: it is handed the agents whose
 * `running` flag is set, and everything else follows.
 */
export interface PresenceLink {
  /**
   * Publish presence for exactly these agents, in these brains.
   *
   * @param desired agent name → brain id, recomputed from the running flags
   */
  want(desired: ReadonlyMap<string, string>): void;
  /** Hand every joined topic a fresher token, which the runner has each poll. */
  refresh(accessToken: string): void;
  /** Close every socket. The run is over and nothing may outlive it. */
  close(): void;
}

/** A link that does nothing, for a runner with nobody to publish for. */
export const silentLink: PresenceLink = {
  want() {},
  refresh() {},
  close() {},
};

/** One agent's socket, and where its single channel stands. */
interface AgentSocket {
  handle: SocketHandle | null;
  open: boolean;
  everOpen: boolean;
  /** Whether the first attempt has resolved, either way. Silence until it has. */
  settled: boolean;
  /**
   * Whether the server refused the join this socket last attempted.
   *
   * Kept apart from `open` because the two are different failures with the same
   * consequence: the transport is fine and the channel is not. It is what stops
   * an open socket on a channel it was refused from reading as working.
   */
  joinRefused: boolean;
  /**
   * Whether the refusal above is only a join that went unanswered.
   *
   * The two read the same everywhere but one place: leaving. A refused join holds
   * no room, so there is nothing to leave. An unanswered one may have landed with
   * only its reply lost, and an agent that moves on without leaving it stays in the
   * old brain's roster until that room's token expires.
   */
  joinTimedOut: boolean;
  /**
   * Whether the server took away a room this socket was holding.
   *
   * The commonest cause is the access token reaching its expiry: Realtime closes
   * the room at that second and leaves the connection up, so the transport is
   * fine and the roster entry is gone. Counted against `open` for the same
   * reason a refusal is, and against nothing else, so the state reads *retrying*
   * rather than *connected* until the room is held again.
   */
  roomLost: boolean;
  /**
   * Whether a join of the current topic has ever been accepted on this socket.
   *
   * Per topic, and cleared when the agent moves to another brain, because a
   * brain whose channel refuses this runner is presence that does not work there
   * however well the last brain went.
   *
   * What tells a refusal that follows a lost room — a rejoin sent with the token
   * that just expired — from a channel that was never going to let this runner
   * in: the first is presence between attempts, the second is presence that
   * does not work, and a person acts on the two differently.
   */
  everJoined: boolean;
  attempt: number;
  /** Consecutive failed joins of the current topic, which paces its rejoin. */
  rejoinAttempt: number;
  /** A pending rejoin of the current topic, so there is never more than one. */
  rejoinTimer: ReturnType<typeof setTimeout> | null;
  /** The bound on the join in flight, cleared when it is answered. */
  joinTimer: ReturnType<typeof setTimeout> | null;
  /** The brain topic this socket is joined to, or trying to join. */
  topic: string | null;
  joinRef: string | null;
  joined: boolean;
  /** The payload to answer a joiner's sync-request with, once joined. */
  payload: unknown;
  retryTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Open the runner's presence connection.
 *
 * Dialling starts immediately for every agent with an identity, before any work
 * has arrived: the value of the connection is that it has been up and has
 * reconnected by the time anything depends on it, and a socket first dialled at
 * the moment it is needed is one whose first real test is a failure.
 */
export function presenceLink(options: PresenceLinkOptions): PresenceLink {
  const openSocket = options.openSocket ?? openWebSocket;
  const sockets = new Map<string, AgentSocket>();
  let ledger: PresenceLedger = emptyLedger;
  let accessToken = options.accessToken;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  let said: ConnectionState | null = null;
  let closed = false;
  let refs = 0;
  const nextRef = () => String(++refs);

  /**
   * Say the aggregate state, and only when it has changed.
   *
   * Deduped because the alternative is a runner narrating every attempt of a
   * socket retrying against a network that is down — which is precisely when a
   * person is least able to read anything else on the screen.
   */
  const sayState = () => {
    if (closed) return;
    const state = aggregateConnection(
      [...sockets.values()].map((s) => ({
        // A refused join is an open socket that puts nothing in a roster, so it
        // is not up now — and, until a join has once been accepted, not ever
        // having been either, since a channel that never let this runner in is
        // presence that does not work rather than presence between attempts.
        open: s.open && !s.joinRefused && !s.roomLost,
        everOpen: s.everOpen && (!s.joinRefused || s.everJoined),
        settled: s.settled,
      })),
    );
    if (state === null || state === said) return;
    said = state;
    options.onState(state);
  };

  const stopRejoin = (socket: AgentSocket) => {
    if (socket.rejoinTimer !== null) clearTimeout(socket.rejoinTimer);
    socket.rejoinTimer = null;
  };

  const stopJoinTimer = (socket: AgentSocket) => {
    if (socket.joinTimer !== null) clearTimeout(socket.joinTimer);
    socket.joinTimer = null;
  };

  const stopTimers = (socket: AgentSocket) => {
    if (socket.retryTimer !== null) clearTimeout(socket.retryTimer);
    if (socket.heartbeatTimer !== null) clearInterval(socket.heartbeatTimer);
    socket.retryTimer = null;
    socket.heartbeatTimer = null;
    stopRejoin(socket);
    stopJoinTimer(socket);
  };

  const send = (socket: AgentSocket, frame: Parameters<typeof encodeFrame>[0]) => {
    if (!socket.open || socket.handle === null) return;
    socket.handle.send(encodeFrame(frame));
  };

  /**
   * Join the topic this socket is meant to be on, if it has one and is open.
   *
   * **Never while a join of it is still unanswered.** Realtime does not refuse a
   * second live join of one topic on one socket: it answers the newcomer `ok`
   * and closes the incumbent, in a close frame that names only the topic. Read by
   * the handler below as *the room I held is gone*, that close would rejoin,
   * which evicts the join just made, which closes — a held room churning for the
   * life of the process. A rejoin timer and a fresher token can both ask while a
   * join is in flight, and this is the one place that can refuse them both.
   */
  const joinTopic = (agent: string, socket: AgentSocket) => {
    if (socket.topic === null || !socket.open) return;
    if (socket.joinRef !== null && !socket.joined && !socket.joinRefused) return;
    const identity = options.identities.get(agent);
    if (identity === undefined) return;
    stopRejoin(socket);
    const key = presenceKeyFor(options.nonce, identity.userId);
    socket.payload = presencePayload(key, identity.userId, identity.name);
    socket.joinRef = nextRef();
    socket.joined = false;
    // Cleared on every attempt, so a policy that changes is picked up by the next
    // reconnect rather than leaving the runner permanently pessimistic.
    socket.joinRefused = false;
    socket.joinTimedOut = false;
    send(socket, joinFrame(socket.topic, key, accessToken, socket.joinRef));
    stopJoinTimer(socket);
    const ref = socket.joinRef;
    socket.joinTimer = setTimeout(() => {
      socket.joinTimer = null;
      if (closed || socket.joinRef !== ref || socket.joined) return;
      // Unanswered is read as refused, and asked again on the backoff. If the
      // join did land and only its reply was lost, the next one is a duplicate the
      // server answers `ok` while closing this one, and that close arrives while
      // the new join is in flight, which is when a close is ignored.
      socket.joinRefused = true;
      socket.joinTimedOut = true;
      scheduleRejoin(agent, socket);
      sayState();
    }, JOIN_TIMEOUT_MS);
    socket.joinTimer.unref?.();
  };

  /**
   * Ask for the current topic again, later.
   *
   * On the shared backoff, so a policy refusal is not asked about in a tight
   * loop, and with whatever token the link holds when the timer fires — a
   * fresher one handed over meanwhile is the remedy, and `refresh` does not wait
   * for this timer to use it.
   */
  const scheduleRejoin = (agent: string, socket: AgentSocket) => {
    if (closed || socket.rejoinTimer !== null) return;
    socket.rejoinAttempt += 1;
    socket.rejoinTimer = setTimeout(() => {
      socket.rejoinTimer = null;
      if (closed || socket.joined) return;
      joinTopic(agent, socket);
    }, backoffDelay(socket.rejoinAttempt, options.random()));
    socket.rejoinTimer.unref?.();
  };

  const onJoined = (socket: AgentSocket) => {
    if (socket.topic === null || socket.joinRef === null) return;
    socket.joined = true;
    socket.everJoined = true;
    socket.roomLost = false;
    socket.rejoinAttempt = 0;
    // An accepted join undoes a give-up: the reply to a join `JOIN_TIMEOUT_MS`
    // already wrote off can still arrive before the rejoin goes out, and a room
    // held under a refusal mark reads as retrying for good and is never left.
    socket.joinRefused = false;
    socket.joinTimedOut = false;
    // Membership is tracked with an empty object, exactly as the browser and the
    // MCP server do: Presence answers *who is here*, and the data every reader
    // renders travels on the broadcast below.
    send(socket, trackFrame(socket.topic, {}, nextRef(), socket.joinRef));
    send(socket, broadcastFrame(socket.topic, EVENTS.activeFile, socket.payload, nextRef(), socket.joinRef));
  };

  const dial = (agent: string, socket: AgentSocket) => {
    if (closed) return;
    const handle = openSocket(options.url, {
      onOpen() {
        socket.open = true;
        socket.everOpen = true;
        socket.settled = true;
        socket.attempt = 0;
        // Unref'd so a heartbeat can never be the reason this process refuses to
        // exit; the run's last line closes the socket anyway.
        socket.heartbeatTimer = setInterval(() => send(socket, heartbeatFrame(nextRef())), HEARTBEAT_MS);
        socket.heartbeatTimer.unref?.();
        joinTopic(agent, socket);
        sayState();
      },
      onMessage(text) {
        const frame = decodeFrame(text);
        if (frame === null) return;
        const reply = replyIn(frame);
        if (reply !== null && reply.ref === socket.joinRef) {
          stopJoinTimer(socket);
          if (reply.ok) {
            onJoined(socket);
          } else {
            // Marked, so the state stops claiming presence works on a socket
            // that is up and useless, **and asked again on the backoff**. The
            // reason is not reliably a policy or a topic name: the commonest one
            // is a token that expired a moment before the join, and that answers
            // differently once a fresher one is in hand.
            socket.joinRefused = true;
            socket.joinTimedOut = false;
            scheduleRejoin(agent, socket);
          }
          sayState();
          return;
        }
        // **A room the server closes under us is the case nothing else sees.** A
        // token reaching its expiry does not drop the connection: Realtime closes
        // the room at that second and the socket goes on answering heartbeats,
        // so neither the reply path above nor `onClosed` below is reached, and
        // the agent is out of the roster with every surface saying *connected*.
        //
        // **Only while the room is held.** A close that arrives while a join is
        // in flight is about an earlier join — the server answers frames in the
        // order they were sent, so the close of a room just left lands before the
        // reply to the join that followed it — and reading it as this room lost
        // would ask a second time for a room already being joined.
        if (frame.event === "phx_error" || frame.event === "phx_close") {
          if (socket.topic === null || frame.topic !== realtimeTopic(socket.topic)) return;
          if (!socket.joined) return;
          socket.joined = false;
          socket.joinRef = null;
          socket.roomLost = true;
          scheduleRejoin(agent, socket);
          sayState();
          return;
        }
        const broadcast = broadcastIn(frame);
        if (broadcast === null || socket.topic === null || !socket.joined) return;
        if (frame.topic !== realtimeTopic(socket.topic)) return;
        // Somebody just opened the brain and is asking who is here. Broadcast
        // carries no snapshot of its own, so a joiner learns nothing about a
        // session that announced itself before they arrived unless it answers.
        //
        // **This is the only unsolicited send after the join, and it is a reply
        // rather than a beat.** There is deliberately no periodic
        // re-announcement: a broadcast is billed per recipient, so a steady
        // beat would cost O(N²) messages per brain. Liveness rides Realtime's
        // own connection heartbeat, which is not billed that way. The absence
        // of a heartbeat here looks like an oversight and is the opposite.
        if (broadcast.event !== EVENTS.syncRequest) return;
        if (socket.joinRef === null) return;
        send(socket, broadcastFrame(socket.topic, EVENTS.activeFile, socket.payload, nextRef(), socket.joinRef));
      },
      onClosed() {
        socket.open = false;
        socket.settled = true;
        socket.joined = false;
        socket.joinRef = null;
        // The re-dial joins whatever the topic is when it opens, so a room lost
        // before the drop is the dial's to recover now, not a rejoin's.
        socket.roomLost = false;
        socket.rejoinAttempt = 0;
        stopTimers(socket);
        sayState();
        if (closed) return;
        socket.attempt += 1;
        socket.retryTimer = setTimeout(() => {
          socket.retryTimer = null;
          dial(agent, socket);
        }, backoffDelay(socket.attempt, options.random()));
        socket.retryTimer.unref?.();
      },
    });
    socket.handle = handle;
    if (handle === null) {
      // No WebSocket in this runtime. Nothing to retry and nothing to wait for:
      // the state says presence is unavailable and the run carries on.
      socket.open = false;
      socket.settled = true;
      sayState();
    }
  };

  for (const agent of options.identities.keys()) {
    const socket: AgentSocket = {
      handle: null,
      open: false,
      everOpen: false,
      settled: false,
      joinRefused: false,
      joinTimedOut: false,
      roomLost: false,
      everJoined: false,
      attempt: 0,
      rejoinAttempt: 0,
      rejoinTimer: null,
      joinTimer: null,
      topic: null,
      joinRef: null,
      joined: false,
      payload: null,
      retryTimer: null,
      heartbeatTimer: null,
    };
    sockets.set(agent, socket);
    dial(agent, socket);
  }
  sayState();

  /** Carry out one pass of the ledger, and arm the timer for the next linger. */
  const settle = (desired: ReadonlyMap<string, string>) => {
    if (closed) return;
    const now = options.now();
    const result = reconcile(ledger, desired, now);
    ledger = result.ledger;
    for (const action of result.actions) {
      const socket = sockets.get(action.agent);
      if (socket === undefined) continue;
      if (action.kind === "leave") {
        // A join still in flight is left too, not only one that was answered: the
        // server takes the two frames in order, so it joins and then leaves, and
        // a join abandoned without a leave would hold a room nobody tracks. So is
        // one given up as unanswered, which may have landed; one the server
        // refused holds nothing to leave.
        if (socket.joinRef !== null && (!socket.joinRefused || socket.joinTimedOut) && socket.topic !== null) {
          send(socket, leaveFrame(socket.topic, nextRef(), socket.joinRef));
        }
        stopRejoin(socket);
        stopJoinTimer(socket);
        socket.topic = null;
        socket.everJoined = false;
        socket.joinRef = null;
        socket.joined = false;
        socket.joinRefused = false;
        socket.joinTimedOut = false;
        socket.roomLost = false;
        socket.rejoinAttempt = 0;
        sayState();
        continue;
      }
      socket.topic = channels.workspacePresence(action.workspace);
      joinTopic(action.agent, socket);
    }
    if (lingerTimer !== null) {
      clearTimeout(lingerTimer);
      lingerTimer = null;
    }
    if (result.nextDeadline === null) return;
    // One timer for the earliest linger rather than one per agent, and it only
    // ever re-runs this same pass — an expiring linger is a change to what
    // should be true that nothing else announces.
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      settle(desired);
    }, Math.max(0, result.nextDeadline - now));
    lingerTimer.unref?.();
  };

  return {
    want(desired) {
      settle(desired);
    },
    refresh(token) {
      accessToken = token;
      for (const [agent, socket] of sockets) {
        if (socket.topic === null) continue;
        if (socket.joined && socket.joinRef !== null) {
          send(socket, accessTokenFrame(socket.topic, token, nextRef(), socket.joinRef));
          continue;
        }
        // **A room wanted and not held is asked for at once.** A fresher token
        // is exactly what makes a refused or lost room answer differently, so
        // waiting out a backoff paced for a policy refusal would leave the agent
        // out of the roster with the remedy already in hand. `joinTopic` drops
        // the ask when a join is already in flight.
        joinTopic(agent, socket);
      }
    },
    close() {
      closed = true;
      if (lingerTimer !== null) clearTimeout(lingerTimer);
      lingerTimer = null;
      for (const socket of sockets.values()) {
        stopTimers(socket);
        socket.handle?.close();
        socket.handle = null;
        socket.open = false;
      }
    },
  };
}
