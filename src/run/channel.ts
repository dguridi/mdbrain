// The Realtime wire, as values: the address to dial, the frames to send, what a
// received frame means, and how long to wait before dialling again.
//
// **Hand-rolled rather than `@supabase/supabase-js`.** This program declares
// three dependencies and compiles with `bun build --compile`; the client library
// is a large thing to bake in for the small part of the protocol a presence
// publisher needs — join a topic, heartbeat, track, send and receive one
// broadcast shape. The honest cost is stated rather than argued away: this is
// new failure surface in a program whose entire network story is otherwise
// `fetch`, and it is a protocol nobody here had written before.
//
// Everything in this file is pure, so the whole of what goes on the wire can be
// asserted without a socket. `realtime.ts` beside it is the socket, the timers
// and the reconnect — the split every module in this folder makes.
//
// **The protocol is Phoenix's, version 1.0.0**, which frames a message as a JSON
// object with named fields. Version 2.0.0 encodes the same five fields as a
// positional array and is what the browser's client negotiates; both are served,
// and the named form is the one a person can read off a packet capture.

// The two names that cross the wall into this program, from the shared package:
// the channel name builders and the event names. Re-exported so the rest of the
// runner reaches one module for the wire rather than two.
import { channels, EVENTS } from "@markdown-den/collab-core";

export { channels, EVENTS };

/** The protocol version this client asks for, as the `vsn` query parameter. */
export const PROTOCOL_VERSION = "1.0.0";

/** Phoenix's own topic, which carries the heartbeat and belongs to no channel. */
export const SOCKET_TOPIC = "phoenix";

/**
 * How often the socket says it is still there.
 *
 * The server drops a connection it has not heard from for a minute, so this sits
 * comfortably inside that. **It is not a re-broadcast**: the heartbeat is one
 * frame to the socket itself, addressed to nobody, and is not billed as a
 * broadcast to every subscriber the way a periodic presence announcement would
 * be. That distinction is the whole of why one of these exists and the other
 * deliberately does not.
 */
export const HEARTBEAT_MS = 25_000;

/**
 * The address of the Realtime socket.
 *
 * The anon key travels as a query parameter because a WebSocket handshake cannot
 * carry headers, and the server's shape follows from that. It authorizes nothing
 * on its own: who is asking travels in the join frame's `access_token`.
 */
export function socketUrl(projectUrl: string, anonKey: string): string {
  const base = projectUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=${PROTOCOL_VERSION}`;
}

/** A channel topic as Realtime addresses it — the shared name, namespaced. */
export function realtimeTopic(name: string): string {
  return `realtime:${name}`;
}

/** One message, in either direction. `ref` is null on a message nobody asked for. */
export interface Frame {
  topic: string;
  event: string;
  payload: unknown;
  ref: string | null;
  join_ref: string | null;
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * A received message, or null when it is not one.
 *
 * Null rather than a throw: this is fed by a socket the far end controls, and a
 * frame this version cannot read is a thing to ignore rather than a reason to
 * tear the connection down.
 */
export function decodeFrame(text: string): Frame | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.topic !== "string" || typeof record.event !== "string") return null;
  return {
    topic: record.topic,
    event: record.event,
    payload: record.payload ?? null,
    ref: typeof record.ref === "string" ? record.ref : null,
    join_ref: typeof record.join_ref === "string" ? record.join_ref : null,
  };
}

/**
 * The frame that joins a topic.
 *
 * **`private: true` is what makes the server ask who this is.** A public topic is
 * joined by anyone who knows its name and the anon key, which means a brain's
 * roster stayed open to a collaborator it had already removed — the workspace id
 * they kept is the whole of what a public join needs. Private makes the join
 * consult a policy on `realtime.messages`, and the policy asks for membership of
 * the brain the topic names. It is written here rather than left to a default for
 * the same reason its opposite was: it reads as a choice somebody made.
 *
 * **The token beside it is the other half and was already right.** A private join
 * is authorized against the token the frame carries, not against the anon key, so
 * `access_token` here and the fresher one `accessTokenFrame` hands the live socket
 * are what the policy actually sees.
 *
 * **A runner that has not been upgraded past this keeps joining public, and a
 * public join and a private join of one topic name do not share a room.** So an
 * old runner is not admitted to something it should not see; it is alone in a
 * topic nobody else is in, present to nobody, reporting success. That is worth
 * knowing when somebody says their agent stopped appearing in the roster.
 *
 * `presence.enabled` is what makes the server maintain a roster for the topic at
 * all; a publisher that only tracks still needs it, because tracking without it
 * is a message the server has nowhere to put.
 */
export function joinFrame(topic: string, presenceKey: string, accessToken: string, ref: string): Frame {
  return {
    topic: realtimeTopic(topic),
    event: "phx_join",
    payload: {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: presenceKey, enabled: true },
        postgres_changes: [],
        private: true,
      },
      access_token: accessToken,
    },
    ref,
    join_ref: ref,
  };
}

/**
 * The frame that joins a topic to *listen* on it, and to be in no roster.
 *
 * The work topic is the one place this program joins something it does not
 * publish to, and presence is off for a reason rather than for economy: a runner
 * listening for work is not working, and an entry in a roster is a claim that
 * somebody is there. Tracking nothing would leave the entry empty; not enabling
 * presence at all leaves the room's membership saying what it means.
 *
 * Private like every other join, because the policy that guards the work topic
 * admits only members and a public join of the same name is a different room.
 */
export function listenFrame(topic: string, accessToken: string, ref: string): Frame {
  return {
    topic: realtimeTopic(topic),
    event: "phx_join",
    payload: {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: "", enabled: false },
        postgres_changes: [],
        private: true,
      },
      access_token: accessToken,
    },
    ref,
    join_ref: ref,
  };
}

/** The frame that leaves a topic, which is what drops the roster entry. */
export function leaveFrame(topic: string, ref: string, joinRef: string): Frame {
  return { topic: realtimeTopic(topic), event: "phx_leave", payload: {}, ref, join_ref: joinRef };
}

/** The frame that puts this publisher in the topic's roster. */
export function trackFrame(topic: string, payload: unknown, ref: string, joinRef: string): Frame {
  return {
    topic: realtimeTopic(topic),
    event: "presence",
    payload: { type: "presence", event: "track", payload },
    ref,
    join_ref: joinRef,
  };
}

/** The frame that carries one broadcast to everyone else on the topic. */
export function broadcastFrame(topic: string, event: string, payload: unknown, ref: string, joinRef: string): Frame {
  return {
    topic: realtimeTopic(topic),
    event: "broadcast",
    payload: { type: "broadcast", event, payload },
    ref,
    join_ref: joinRef,
  };
}

/**
 * The frame that hands a joined topic a fresher token.
 *
 * An access token lasts about an hour and this is a socket a person leaves up
 * for days, so a connection held on the token it was dialled with is one the
 * server eventually closes. The runner already refreshes before every poll; this
 * is that same token, given to the socket as well as to the request.
 */
export function accessTokenFrame(topic: string, accessToken: string, ref: string, joinRef: string): Frame {
  return {
    topic: realtimeTopic(topic),
    event: "access_token",
    payload: { access_token: accessToken },
    ref,
    join_ref: joinRef,
  };
}

export function heartbeatFrame(ref: string): Frame {
  return { topic: SOCKET_TOPIC, event: "heartbeat", payload: {}, ref, join_ref: null };
}

/**
 * The reply a received frame is, and what it said — or null when it is not one.
 *
 * **Matched on `ref` alone, and `join_ref` is deliberately not consulted.** The
 * 1.0.0 serializer sends no `join_ref` on a server frame at all, so a rule that
 * required one would never recognise a join reply: the join would be answered,
 * ignored, and the publisher would sit open on a channel it never finished
 * joining — present to nobody, with nothing saying so. The caller knows which of
 * its own refs was the join and compares against that, which is the same thing
 * the browser's client does.
 */
export function replyIn(frame: Frame): { ref: string; ok: boolean } | null {
  if (frame.event !== "phx_reply" || frame.ref === null) return null;
  const payload = frame.payload;
  const status =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).status : undefined;
  return { ref: frame.ref, ok: status === "ok" };
}

/**
 * The broadcast a received frame carries, or null when it carries none.
 *
 * The server wraps a broadcast in an envelope naming the event, which is why the
 * frame's own `event` is always `broadcast` and the interesting name is inside.
 */
export function broadcastIn(frame: Frame): { topic: string; event: string; payload: unknown } | null {
  if (frame.event !== "broadcast") return null;
  const payload = frame.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const inner = payload as Record<string, unknown>;
  if (typeof inner.event !== "string") return null;
  return { topic: frame.topic, event: inner.event, payload: inner.payload ?? null };
}

/**
 * What the runner says about its presence connection, and the whole of it.
 *
 * **The runner reports what it did, and the app reports what is.** These three
 * are facts about the connection this program holds; whether an agent is in a
 * roster is a consequence, and it is seen where it actually lives — the roster
 * in the browser. Rendering presence here would be the runner guessing at a
 * state the browser already holds for certain, and a disagreement between the
 * two would be a bug with no correct side.
 */
export type ConnectionState = "connected" | "retrying" | "unavailable";

/**
 * One state for however many sockets the runner holds.
 *
 * A person watching wants to know whether presence is working, not which of four
 * connections is between attempts — so the aggregate is deliberately pessimistic
 * about `connected` and deliberately distinguishes *never worked* from *working
 * a moment ago*, which are the two a person would act on differently.
 *
 * **`settled` is what keeps a runner from opening with bad news.** A connection
 * that is still making its very first attempt has not failed; saying
 * *unavailable* about it would put the one line a person acts on onto the screen
 * of every healthy startup, for as long as a handshake takes.
 *
 * **`open` means usable for presence, not merely dialled.** A socket whose join
 * was refused is up and useless: the roster it was opened for will never show
 * anything, and reporting *connected* about it would be the screen saying the one
 * thing that is comfortably false.
 *
 * @param links one entry per connection: whether it is up and usable now, whether
 *   it has ever been, and whether its first attempt has resolved either way
 * @returns null when there is nothing to say — a runner publishing for nobody,
 *   or one whose first attempts are still in flight. Silence rather than a claim,
 *   since nothing has happened to report.
 */
export function aggregateConnection(
  links: readonly { open: boolean; everOpen: boolean; settled: boolean }[],
): ConnectionState | null {
  if (links.length === 0) return null;
  if (links.every((link) => link.open)) return "connected";
  if (links.some((link) => !link.settled)) return null;
  if (links.some((link) => link.everOpen)) return "retrying";
  return "unavailable";
}

/**
 * The sentence for a connection state, said once by whichever presenter is
 * drawing.
 *
 * Each one names the consequence rather than the mechanism, because the
 * consequence is the only part a person can act on — and each says what is
 * *still* true, since the failure this is most likely to be read during is one
 * where somebody is deciding whether the runner is working at all.
 */
export function connectionText(state: ConnectionState): string {
  switch (state) {
    case "connected":
      return "presence is connected; agents will appear in a brain's roster while they run";
    case "retrying":
      return "the presence connection dropped and is being retried; work still arrives by poll";
    case "unavailable":
      return "presence is unavailable, so a running agent will not appear in a brain's roster; work still arrives by poll";
  }
}

/**
 * What the runner says about the socket it listens for work on.
 *
 * **A separate vocabulary from the presence connection rather than a reuse of
 * it**, because the two sockets fail differently and a person acts on them
 * differently. Presence being down costs a dot in somebody else's browser; this
 * being down costs every work signal, which is the difference between work
 * starting in seconds and work starting at the end of a poll interval.
 *
 * `silent` is the state the others do not cover and the one worth having: there
 * is no socket at all, because the runner was never told which brains to listen
 * to. Every failure of that lookup answers with no brains, so without a word for
 * it a runner that is not listening is indistinguishable from a brain where
 * nothing is happening.
 */
export type ListeningState = "listening" | "partial" | "retrying" | "unavailable" | "silent";

/**
 * Where the listening socket stands, over however many rooms it holds.
 *
 * **`settled` is what keeps a healthy start from opening with bad news**, the
 * same rule the presence aggregate follows: a first attempt still in flight has
 * not failed, and saying *unavailable* about it would put the one line a person
 * acts on onto the screen of every good startup for as long as a handshake takes.
 *
 * @param rooms how many work topics are held and how many there are, plus
 *   whether the socket has ever been usable and whether its first attempt has
 *   resolved either way
 * @returns null when there is nothing to say yet — silence rather than a claim
 */
export function aggregateListening(rooms: {
  held: number;
  total: number;
  everOpen: boolean;
  settled: boolean;
}): ListeningState | null {
  // Nothing to listen to is a settled fact the moment it is known: there is no
  // socket whose first attempt could still be in flight.
  if (rooms.total === 0) return "silent";
  if (rooms.held >= rooms.total) return "listening";
  if (!rooms.settled) return null;
  if (rooms.held > 0) return "partial";
  return rooms.everOpen ? "retrying" : "unavailable";
}

/**
 * The sentence for a listening state, said by whichever presenter is drawing.
 *
 * Each names the consequence rather than the mechanism, and each says what is
 * **still** true — because the moment this is most likely to be read is the one
 * where somebody is deciding whether the runner is working at all.
 *
 * @param state where the socket stands
 * @param held how many work topics are currently held
 * @param total how many there are to hold
 */
export function listeningText(state: ListeningState, held: number, total: number): string {
  const brains = (n: number) => `${n} ${n === 1 ? "brain" : "brains"}`;
  switch (state) {
    case "listening":
      return `listening for work in ${brains(total)}; work arrives within seconds of landing`;
    case "partial":
      return `listening for work in ${held} of ${brains(total)}; the rest are being retried and their work arrives by poll`;
    case "retrying":
      return `the work-signal connection dropped and is being retried; work arrives by poll until it is back`;
    case "unavailable":
      return `the work-signal connection is unavailable, so work arrives by poll rather than on arrival`;
    case "silent":
      // **States what happened, not why.** This is also where a refused or slow
      // brain lookup lands, so naming a cause would assert one of several the
      // runner cannot tell apart — and the reader would act on the wrong one.
      return "not listening for work signals: no brains to listen to came back, so work arrives by poll";
  }
}

/** The first delay, and the ceiling every later one is capped at. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CEILING_MS = 30_000;

/**
 * How long to wait before attempt number `attempt`, jittered.
 *
 * **The jitter is not a refinement.** Every runner on one flaky network drops at
 * the same moment and, on a fixed schedule, would reconnect at the same moment
 * too — a herd arriving together against one project, repeatedly, for as long as
 * the network stays bad. The delay is therefore drawn from the top half of a
 * doubling window rather than sitting at its edge: still bounded, still growing,
 * and no two runners on the same schedule.
 *
 * @param attempt 1 for the first retry after a drop, growing from there
 * @param random a value in [0, 1) — the caller's, so this stays pure
 * @returns the delay in milliseconds, never above the ceiling
 */
export function backoffDelay(attempt: number, random: number): number {
  const window = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CEILING_MS);
  return Math.round(window / 2 + random * (window / 2));
}
