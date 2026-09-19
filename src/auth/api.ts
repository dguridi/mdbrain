// Every request this program makes, and nothing else.
//
// The thin edge around the pure core: each function here is one HTTP call whose
// shape is decided elsewhere. They are gathered in one module so the whole of
// what the binary can reach is readable at once — three auth endpoints, three
// table reads and one RPC, every one of them carrying a session this program
// already holds. **Nothing here can create one**: the app's page obtains the
// session and hands it over, so there is no call that trades anything for
// tokens.
//
// One call receives a credential rather than sending one: `mintAgentKey` asks
// the server for an agent's connection key. It is worth being exact about the
// direction, because the two are easy to conflate — the key is **minted by the
// server**, under a gate this program cannot influence, and this program only
// receives and stores it.
//
// **No retries anywhere, deliberately.** A refused refresh means the session is
// over, and asking again cannot change that; a network failure is the person's
// to see and act on. A loop here would turn one clear sentence into a hang.

import { ANON_KEY, APP_URL, PROJECT_URL } from "./project.ts";
import type { StoredSession } from "./session.ts";
import { STARTUP_ASK_TIMEOUT_MS, versionHeader } from "../upgrade/floor.ts";
import { VERSION } from "../version.ts";

/** What the token endpoint hands back, reduced to the three fields kept. */
interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  expires_in?: unknown;
}

/**
 * A failure that is worth showing a person as it stands.
 *
 * The field is declared and assigned rather than written as a constructor
 * parameter property: Node runs these files by stripping the types out, which
 * cannot do a parameter property because it would have to *emit* an assignment.
 * The binary being runnable with plain `node` is worth more than the shorthand.
 */
export class AuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function headers(accessToken?: string): Record<string, string> {
  const h: Record<string, string> = { apikey: ANON_KEY, "content-type": "application/json" };
  // The anon key is the API key; the bearer is who is asking. Both are needed —
  // PostgREST rejects a request with no `apikey`, and RLS sees nobody without
  // the bearer.
  if (accessToken) h.authorization = `Bearer ${accessToken}`;
  return h;
}

/**
 * The headers the app's own routes take.
 *
 * No `apikey`: these are Next.js routes rather than PostgREST, and the bearer is
 * the whole of what authorises them — the same human session `mdbrain login`
 * obtained, judged by row-level security once it reaches the database.
 *
 * **Every one of them names this build's version**, which is what lets a server
 * tell an old runner from a new one — it could not before, and a floor it cannot
 * see is a floor it cannot set. It is one header carrying one fact: the channel,
 * the target and the engine are known here too and are deliberately not sent.
 */
function appHeaders(accessToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    ...versionHeader(VERSION),
  };
}

/**
 * POST to one of the app's own routes, refusing to follow a redirect.
 *
 * **A redirect is an error here rather than something to follow.** Crossing
 * origins strips the `Authorization` header, so following one turns a working
 * credential into a 401 that reads exactly like being signed out — which is what
 * the apex domain did to every one of these calls until `APP_URL` gained its
 * `www.`. Naming it costs one branch and saves the next person the hour it cost
 * to find, so the redirect is reported with the address it wanted to go to.
 */
async function callApp(
  method: "GET" | "POST",
  path: string,
  accessToken: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  // The body is spread in rather than set to undefined: a `body` key holding
  // undefined is not the same as no body to a type that says what a request may
  // carry, and the question the floor asks carries none.
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: appHeaders(accessToken),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location") ?? "somewhere else";
    throw new AuthError(
      0,
      `${APP_URL}${path} redirected to ${to}. A redirect drops the credential, so this is a wrong address rather than a refused session — mdbrain is pointed at the wrong origin.`,
    );
  }
  return res;
}

/** POST to one of the app's own routes. The verb every call but the floor's takes. */
function postToApp(path: string, accessToken: string, body: unknown): Promise<Response> {
  return callApp("POST", path, accessToken, body);
}

/** Read a token response into a session, or say why it is not one. */
function toSession(body: TokenResponse, nowSeconds: number): StoredSession {
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new AuthError(0, "The server's answer did not contain a session.");
  }
  // `expires_at` is what Supabase sends; `expires_in` is the fallback, because a
  // session with no expiry would be treated as valid forever by the refresh
  // decision and would fail on the first request instead.
  const expiresAt =
    typeof body.expires_at === "number"
      ? body.expires_at
      : nowSeconds + (typeof body.expires_in === "number" ? body.expires_in : 3600);
  return { accessToken, refreshToken, expiresAt };
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      for (const field of ["error_description", "msg", "message", "error"]) {
        if (typeof record[field] === "string") return record[field];
      }
    }
  } catch {
    // Not JSON; the raw text is the best thing to say.
  }
  return text.slice(0, 300) || `HTTP ${res.status}`;
}

/**
 * Buy a new access token with the refresh token.
 *
 * A refusal here is not a network problem and must not be retried: it means the
 * session has been ended, by expiry or by *sign out other devices*.
 */
export async function refreshSession(refreshToken: string, nowSeconds: number): Promise<StoredSession> {
  const res = await fetch(`${PROJECT_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) throw new AuthError(res.status, await readError(res));
  return toSession((await res.json()) as TokenResponse, nowSeconds);
}

/**
 * End this session on the server, and only this one.
 *
 * `scope=local` is the whole point: a signed-in browser is a different session
 * and stays signed in. `global` and `others` reach across to it, which is the
 * app's own *sign out other devices* and not this command's business.
 */
export async function signOutLocal(accessToken: string): Promise<void> {
  const res = await fetch(`${PROJECT_URL}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: headers(accessToken),
  });
  // A 401 is **not** "the server had already forgotten it". It says this access
  // token was not accepted — which an expired one never is, and an access token
  // outlives its hour far less often than a session outlives a day. Nothing was
  // revoked in that case, and the refresh token stored beside it is still live.
  // The two causes are indistinguishable from here, so the ambiguous one is
  // raised rather than reported as success: a `logout` that says *revoked* while
  // leaving a usable refresh token on a server is the single outcome this
  // command exists to prevent.
  if (!res.ok) throw new AuthError(res.status, await readError(res));
}

/** Who the session belongs to, for `whoami` to name. */
export async function currentUser(accessToken: string): Promise<{ email: string | null; id: string | null }> {
  const res = await fetch(`${PROJECT_URL}/auth/v1/user`, { headers: headers(accessToken) });
  if (!res.ok) throw new AuthError(res.status, await readError(res));
  const body = (await res.json()) as Record<string, unknown>;
  return {
    email: typeof body.email === "string" ? body.email : null,
    id: typeof body.id === "string" ? body.id : null,
  };
}

/** One organization the signed-in account can see. */
export interface Organization {
  id: string;
  name: string;
}

/** One agent, as the roster read returns it. */
export interface Agent {
  id: string;
  org_id: string;
  display_name: string;
  status: string;
  /**
   * The account the agent acts as, which is what a roster dedupes on and what
   * its colour is derived from.
   *
   * Read here rather than looked up later because there is nowhere later to look
   * it up from: this is the only roster read the runner makes. The column has
   * always existed and the SELECT policy already admits any organization member,
   * so asking for it is one more name in the select and no migration.
   */
  bot_user_id: string;
}

/**
 * One PostgREST read under the caller's own RLS.
 *
 * @param signal bounds the wait where a caller has one to give. Most reads here
 *   are made by a command that is about to exit and can be left to the network's
 *   own timeout; a caller inside `run` is not, because an abandoned request with
 *   nothing cancelling it keeps the process alive past its last printed line.
 */
async function selectRows<T>(path: string, accessToken: string, signal?: AbortSignal): Promise<T[]> {
  const res = await fetch(`${PROJECT_URL}/rest/v1/${path}`, { headers: headers(accessToken), signal: signal ?? null });
  if (!res.ok) throw new AuthError(res.status, await readError(res));
  return (await res.json()) as T[];
}

/**
 * The organizations this account belongs to, and the agents in them.
 *
 * Both reads go through PostgREST under the caller's own RLS, which is what
 * makes them the proof the login works: an anonymous request returns nothing and
 * a stale token is refused, so rows coming back mean the session is real.
 */
export function listOrganizations(accessToken: string): Promise<Organization[]> {
  return selectRows<Organization>("organizations?select=id,name&order=name", accessToken);
}

export function listAgents(accessToken: string): Promise<Agent[]> {
  return selectRows<Agent>("agents?select=id,org_id,display_name,status,bot_user_id&order=display_name", accessToken);
}

/** One organization membership of the signed-in account, with the role it holds there. */
export interface Membership {
  org_id: string;
  role: string;
}

/**
 * The roles this account holds in the organizations it belongs to.
 *
 * `configure` needs it to answer a question the agent roster cannot: whether the
 * account may *manage* a given agent, which is the same right that governs
 * adding and deleting one in the app's settings. The read is filtered by the
 * account's own id rather than trusted to return only its own rows, because the
 * SELECT policy admits the whole roster of every organization it is in.
 */
export function listMemberships(accessToken: string, userId: string): Promise<Membership[]> {
  return selectRows<Membership>(`organization_members?select=org_id,role&user_id=eq.${encodeURIComponent(userId)}`, accessToken);
}

/**
 * Ask the server to mint a connection key for one agent, and receive it.
 *
 * **This program never mints a key.** The secret is generated inside the
 * database by `mint_agent_key`, which stores only its hash and hands the
 * plaintext back once, gated by the same owner check that governs adding and
 * deleting the agent. Everything this function does is ask, and everything the
 * caller does is store what came back.
 */
export async function mintAgentKey(accessToken: string, agentId: string): Promise<string> {
  const res = await fetch(`${PROJECT_URL}/rest/v1/rpc/mint_agent_key`, {
    method: "POST",
    headers: headers(accessToken),
    body: JSON.stringify({ p_agent_id: agentId }),
  });
  if (!res.ok) throw new AuthError(res.status, await readError(res));
  // A table-returning function answers with an array of rows; one row, one key.
  const body: unknown = await res.json();
  const row = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : (body as Record<string, unknown>);
  const key = row?.key;
  if (typeof key !== "string" || key === "") throw new AuthError(0, "The server's answer did not contain a connection key.");
  return key;
}

/**
 * The brains this runner should listen to for work signals.
 *
 * A runner is configured with agent names and learns which brain a unit came
 * from only when it is handed one — which is exactly too late to have been
 * listening. So it asks, once at startup, and the answer is the set of topics to
 * join.
 *
 * **The answer is not a permission and is not treated as one.** It is a listening
 * hint: every brain in it is one the caller could already see, and being told
 * about one grants nothing — the claim is still authorised on its own, and a
 * signal still only causes a read. A brain missing from the answer costs the
 * latency of one poll interval and nothing else.
 *
 * Through PostgREST under the caller's own RLS rather than the app, because it is
 * a plain read of the database with no server-side work in front of it.
 *
 * @param signal bounds the wait, and the caller is expected to pass one: this
 *   read sits ahead of the first poll, so a request that hangs would stall the
 *   thing it exists to make faster — a runner that never starts looking for work
 *   because it is still asking which rooms to listen in.
 */
export async function signalBrains(
  accessToken: string,
  agents: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await fetch(`${PROJECT_URL}/rest/v1/rpc/signal_brains`, {
    method: "POST",
    headers: headers(accessToken),
    body: JSON.stringify({ p_agent_names: agents }),
    signal: signal ?? null,
  });
  if (!res.ok) throw new AuthError(res.status, await readError(res));
  const body: unknown = await res.json();
  if (!Array.isArray(body)) return [];
  return body
    .map((row) => (row as Record<string, unknown>)?.workspace_id)
    .filter((id): id is string => typeof id === "string" && id !== "");
}

/**
 * What those brains are called, by id.
 *
 * The runner is handed brain ids and never names, so the one place a person sees
 * which brain an agent is working in would otherwise be a UUID. This is the read
 * that answers it: a plain `workspaces` select through the same helper every
 * other read here uses, filtered to the ids the listen lookup came back with.
 *
 * **A plain read rather than widening `signal_brains` to return the name.** That
 * RPC is `SECURITY INVOKER` and the `workspaces` SELECT policy admits the owner
 * and any member, so both answer the same question to the same person — but
 * changing an RPC's return type needs a `DROP` and a `CREATE` in a new migration,
 * and this needs none. The migration is the better choice only if something else
 * comes to want the name on that call.
 *
 * **It answers with what it could read and never refuses the caller.** A name
 * this cannot see is simply absent from the map, which is the same shape as the
 * whole read failing — and the caller's line drops the name rather than waiting
 * for it, so nothing on the path that starts work depends on this.
 *
 * @param ids the brains to name; an empty list is answered without a request
 * @param signal bounds the wait, and the caller is expected to pass one for the
 *   same reason `signalBrains` is: this is made by the command a person leaves
 *   running, so a request nothing cancels holds the process open after it has
 *   said it stopped — for a field that only ever decorates a line.
 * @returns id to name, holding only the rows that came back
 */
export async function listWorkspaceNames(
  accessToken: string,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)].filter((id) => id !== "");
  if (wanted.length === 0) return new Map();
  // One request for the whole set rather than one each: this runs beside the
  // listen lookup, which happens once per process while no link is open, and a
  // request per brain would
  // turn a runner watching a dozen into a dozen round trips for a cosmetic field.
  const filter = `in.(${wanted.map((id) => encodeURIComponent(id)).join(",")})`;
  const rows = await selectRows<{ id: string; name: string }>(`workspaces?select=id,name&id=${filter}`, accessToken, signal);
  const names = new Map<string, string>();
  for (const row of rows) {
    if (typeof row?.id === "string" && typeof row?.name === "string" && row.name !== "") names.set(row.id, row.name);
  }
  return names;
}

/** Where the startup question is asked, which the two work calls deliberately do not share. */
const RUNNER_START_PATH = "/api/runner/start";

/** What the server answered when asked whether this build may start. */
export interface StartupAnswer {
  status: number;
  /** The server's own words when it refused, or "" when it did not. */
  said: string;
  /** The floor it named, when its answer carried one. */
  minimum: string | null;
  /** The version it says it received, which is null when the header did not reach it. */
  sent: string | null;
}

/**
 * Ask whether a runner of this version may start.
 *
 * Asked once, before the first poll, by a command that takes work — and on a
 * route the count and the claim do not share, so that *a run already going is
 * never refused for being old* is a property of where the question lives rather
 * than of how a condition happens to be written.
 *
 * **A failure is the caller's to read as permission.** This throws what `fetch`
 * throws and reports what the server said; it does not decide, and the decision
 * — that only a refusal refuses, and silence never does — is `upgrade/floor.ts`'s.
 *
 * **Bounded, because it is asked in front of everything else.** A host that
 * accepts a connection and never answers would otherwise hold the command at a
 * blank terminal for `fetch`'s own timeout, and an abandoned question is a start
 * rather than a refusal.
 *
 * @returns the status, the server's sentence, the floor it named, and the version
 *   it says arrived
 */
export async function askToStart(accessToken: string): Promise<StartupAnswer> {
  const res = await callApp("GET", RUNNER_START_PATH, accessToken, undefined, AbortSignal.timeout(STARTUP_ASK_TIMEOUT_MS));
  if (res.ok) return { status: res.status, said: "", minimum: null, sent: null };
  // Read once and read here, rather than through `readError`: the floor travels
  // as a field beside the sentence, and a body can only be consumed once — so a
  // second reader would get the words and lose the number.
  const text = await res.text().catch(() => "");
  let said = text;
  let minimum: string | null = null;
  let sent: string | null = null;
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      if (typeof record.error === "string") said = record.error;
      if (typeof record.minimum === "string") minimum = record.minimum;
      if (typeof record.sent === "string") sent = record.sent;
    }
  } catch {
    // Not JSON at all, which is what a proxy or an error page answers with. The
    // words are whatever came back, and the caller caps and redacts them.
  }
  return { status: res.status, said: said.trim(), minimum, sent };
}
/**
 * How much work is waiting for these agents, without taking any of it.
 *
 * The cheap gate in front of the claim: a poll asks this every tick and asks for
 * the work only when the answer is more than none, which is what keeps a
 * five-minute poll a read rather than a write. **It claims nothing** — a runner
 * that only looked must not have consumed what it looked at.
 *
 * This one and the claim below go to the **app** rather than to PostgREST: they
 * are the app's own routes, authorised by the same human session as everything
 * else here, so there is no `apikey` to send.
 */
export async function askForCount(
  accessToken: string,
  agents: string[],
): Promise<{ waiting: number; capped: boolean }> {
  const res = await postToApp("/api/events/count", accessToken, { agents });
  if (!res.ok) throw new AuthError(res.status, await readError(res));
  const body: unknown = await res.json();
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const waiting = typeof record.waiting === "number" ? record.waiting : 0;
  return { waiting, capped: record.capped === true };
}

/**
 * Take this runner's next units of work.
 *
 * **The claim is terminal**: taking the work is what marks it done, and there is
 * no acknowledgement afterwards. So a caller must never ask for more than it
 * will run — which is why `limit` is 1 and the queue exists.
 *
 * The body is answered unread: `readWork` in `../work/instruction.ts` is what
 * decides whether it is one, and keeping that here would put the contract in the
 * module that cannot be tested without a socket.
 */
export async function claimWork(
  accessToken: string,
  agents: string[],
  limit: number,
  sessionsPerHour: number | null,
): Promise<unknown> {
  const res = await postToApp(
    "/api/events/claim",
    accessToken,
    sessionsPerHour === null ? { agents, limit } : { agents, limit, sessionsPerHour },
  );
  if (!res.ok) throw new AuthError(res.status, await readError(res));
  return res.json();
}
