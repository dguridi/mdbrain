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
  attempt: number;
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
        // A refused join is an open socket that will never put anything in a
        // roster, so it counts as neither up now nor ever having been.
        open: s.open && !s.joinRefused,
        everOpen: s.everOpen && !s.joinRefused,
        settled: s.settled,
      })),
    );
    if (state === null || state === said) return;
    said = state;
    options.onState(state);
  };

  const stopTimers = (socket: AgentSocket) => {
    if (socket.retryTimer !== null) clearTimeout(socket.retryTimer);
    if (socket.heartbeatTimer !== null) clearInterval(socket.heartbeatTimer);
    socket.retryTimer = null;
    socket.heartbeatTimer = null;
  };

  const send = (socket: AgentSocket, frame: Parameters<typeof encodeFrame>[0]) => {
    if (!socket.open || socket.handle === null) return;
    socket.handle.send(encodeFrame(frame));
  };

  /** Join the topic this socket is meant to be on, if it has one and is open. */
  const joinTopic = (agent: string, socket: AgentSocket) => {
    if (socket.topic === null || !socket.open) return;
    const identity = options.identities.get(agent);
    if (identity === undefined) return;
    const key = presenceKeyFor(options.nonce, identity.userId);
    socket.payload = presencePayload(key, identity.userId, identity.name);
    socket.joinRef = nextRef();
    socket.joined = false;
    // Cleared on every attempt, so a policy that changes is picked up by the next
    // reconnect rather than leaving the runner permanently pessimistic.
    socket.joinRefused = false;
    send(socket, joinFrame(socket.topic, key, accessToken, socket.joinRef));
  };

  const onJoined = (socket: AgentSocket) => {
    if (socket.topic === null || socket.joinRef === null) return;
    socket.joined = true;
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
          if (reply.ok) {
            onJoined(socket);
          } else {
            // A refused join is left alone rather than retried in a loop: the
            // reason is a policy or a topic name, and neither changes by asking
            // again. It is marked instead, so the state stops claiming presence
            // works on a socket that is up and useless.
            socket.joinRefused = true;
          }
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
      attempt: 0,
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
        if (socket.joined && socket.joinRef !== null && socket.topic !== null) {
          send(socket, leaveFrame(socket.topic, nextRef(), socket.joinRef));
        }
        socket.topic = null;
        socket.joinRef = null;
        socket.joined = false;
        socket.joinRefused = false;
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
      for (const socket of sockets.values()) {
        if (!socket.joined || socket.topic === null || socket.joinRef === null) continue;
        send(socket, accessTokenFrame(socket.topic, token, nextRef(), socket.joinRef));
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
