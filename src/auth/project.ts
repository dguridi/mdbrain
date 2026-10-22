// The one markdownbrain.ai this CLI talks to.
//
// Production, and only production. There is no environment variable and no flag
// — the HTTP API's address, at the bottom, is the one exception and says why —
// and that is a decision about scope rather than a limit anything imposes: one
// address means one thing to get wrong, and a session that could be minted by
// whatever a variable happened to name is a session whose origin nobody can read
// off the file it rests in.
//
// **It is deliberately not justified by the Auth redirect allowlist**, which is
// what this comment used to say. Nothing here redirects — the app's page posts
// to the loopback — so the allowlist is never consulted, and a login against a
// local stack is not the closed door that reasoning described. Pointing this at
// one is a change to the decision above, which is Diego's, not a matter of
// making something impossible work.
//
// **Both values are public**, and that is what makes hardcoding them correct
// rather than a leak: the web app ships exactly these two to every browser that
// loads it. The anon key authorizes nothing on its own — every request it
// accompanies is still judged by RLS under whatever session carries it.

import type { Judged } from "../api/call.ts";

/** The project's base URL, which every auth and REST request is built on. */
export const PROJECT_URL = "https://rczxydsqwkzobebirkcu.supabase.co";

/**
 * The app's own origin, which is where signing in happens and where the two
 * event routes live.
 *
 * The login opens a page here rather than an identity provider, because the app
 * is the one door every account can come through — including an account with an
 * email and a password and no provider at all. **The listener does not compare a
 * request's `Origin` against it**: a browser sends `Origin: null` when an https
 * page posts to an http loopback address, so that check refused the real
 * handover and nothing else.
 *
 * **The bare host is load-bearing, and `www.` must not be added.** It is the
 * canonical host and serves `/api/…` itself, while `https://www.markdownbrain.ai`
 * answers with a `308` to it — and a redirect that crosses origins **drops the
 * `Authorization` header**, so a request sent through one arrives with no
 * credential and is refused as though the person were signed out. A valid token
 * and a malformed one come back byte-identical, which makes it about as
 * misleading as a failure can be. Runners already installed call
 * `https://www.markdown-den.com/api/…` instead, so that origin has to go on
 * serving `/api` itself, without a redirect, for as long as they are in use.
 *
 * **Nothing in a browser exercises this.** The login only opens a page, which
 * follows any redirect and carries no header of ours; only the bearer calls
 * `run` makes would notice.
 */
export const APP_URL = "https://markdownbrain.ai";

/**
 * The **anon** key, sent as the `apikey` header.
 *
 * Never the service-role key, which bypasses RLS entirely and would turn this
 * binary into a copy of the database for anyone holding it. `anonKeyRole` exists
 * so a test can refuse the wrong one rather than trusting whoever pasted it.
 */
export const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjenh5ZHNxd2t6b2JlYmlya2N1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxMjYxNTIsImV4cCI6MjA5ODcwMjE1Mn0.97oBeY8c2HzQJUqIrw-dpohiQ4JX2iduykBOFJMjtP0";

/**
 * The `role` a Supabase key claims, read from the JWT's payload without
 * verifying its signature.
 *
 * Not a security check — nothing here could verify one, and a forged key would
 * simply be refused by the server. It exists to catch the paste that matters: a
 * `service_role` key put where the anon key goes looks identical at a glance and
 * would ship unrestricted database access inside a binary people install.
 *
 * @returns the claimed role, or null when the text is not a readable JWT
 */
export function keyRole(key: string): string | null {
  const payload = key.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null) return null;
    const role = (claims as Record<string, unknown>).role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

/**
 * The MCP server an agent's harness session is pointed at, and the address
 * written into every per-agent MCP file this program produces.
 *
 * Production only, like the two above: the workspace connection is the one
 * thing a session must not be able to be redirected by editing a text file,
 * since the private-folder wall is per identity and the identity is the key
 * that file names. **This value is not read off the repository** — the web app
 * takes its copy from an environment variable at build time — so it is the one
 * constant here worth checking against the app's own agent dialog.
 *
 * It is also the OAuth resource every connector grant is bound to, so it moves
 * only together with the web app's `NEXT_PUBLIC_MCP_URL`, which must say
 * exactly this, and the MCP server's `MCP_PUBLIC_URL`, which is this without
 * its `/mcp`.
 */
export const MCP_URL = "https://mcp.markdownbrain.ai/mcp";

/**
 * The HTTP API `call`, `read` and `upload` speak to, served beside the MCP
 * endpoint under its own name so the public address does not say "mcp".
 */
export const API_URL = "https://api.markdownbrain.ai/v1";

/**
 * The API address this invocation uses: `MDBRAIN_API_URL` when it is set, this
 * binary's own constant otherwise.
 *
 * **This is the one address here an environment variable may move**, and the
 * reasons the others may not do not reach it. Nothing is minted or stored
 * against it — no session, no MCP file — and the credential it is used with is
 * itself read from the environment on every invocation, so whoever can set the
 * one can already set the other. What the override buys is pointing the
 * commands at a local stack.
 *
 * **Plain `http` is refused except to this machine.** That reasoning covers a
 * hostile environment, not a mistaken one: a typo or a stale CI variable naming
 * `http://` would send the key in cleartext on every invocation, and the server's
 * redirect to `https` comes only after the key has crossed the wire. A local
 * stack is the one place `http` is wanted, and there the key never leaves the
 * machine.
 *
 * @returns the address without a trailing slash, or why the one given cannot be
 *   used — decided before anything is sent
 */
export function apiBase(env: Record<string, string | undefined>): Judged<string> {
  const given = env.MDBRAIN_API_URL?.trim();
  const value = (given ? given : API_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: `MDBRAIN_API_URL is not an address: ${value}` };
  }
  if (url.protocol === "https:") return { ok: true, value };
  if (url.protocol === "http:" && isLoopback(url.hostname)) return { ok: true, value };
  return {
    ok: false,
    message: `MDBRAIN_API_URL must be https (plain http only to localhost, 127.0.0.1 or [::1]), or the key would be sent unencrypted: ${value}`,
  };
}

/**
 * Whether the person's login may be sent to an API address: only to this
 * binary's own `API_URL`, or to this machine.
 *
 * **A key and a login are not the same risk at a strange address.** A member key
 * is fenced to one organization, rate-limited and revocable on its own. A
 * session's access token works against the database as the person, in every
 * organization they belong to, until it expires — so an `MDBRAIN_API_URL` left
 * pointing somewhere else must never be handed one. A key is still sent there,
 * as it always was, because setting the address and the key are one decision.
 *
 * @param base an address `apiBase` accepted
 */
export function loginMayGoTo(base: string): boolean {
  if (base === API_URL) return true;
  try {
    return isLoopback(new URL(base).hostname);
  } catch {
    return false;
  }
}

/** Whether a host, as `URL` spells it, is this machine: `localhost`, any of
 *  127.0.0.0/8, or `[::1]` (which `URL` writes every spelling of as). */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The name that server is given inside the per-agent MCP file.
 *
 * It lives beside the address because two modules must agree on it and neither
 * owns it: `store.ts` writes it as the key under `mcpServers`, and `harness.ts`
 * names the harness's tools after it when it grants the session the one server
 * it was handed. Written twice, the session would be granted tools no server
 * offers and refused the ones it needs, and nothing would say so.
 *
 * **A file on disk written by an older binary may still carry the old name**,
 * which is the same disagreement split across two builds. `run` rewrites each
 * agent's file from this binary's constants when it starts, which closes it for
 * every session `run` launches. The name also prefixes every tool a session
 * sees (`mcp__markdownbrain__whoami`), so an allow-list or a prompt somebody
 * wrote by hand against the old prefix stops matching when this changes.
 */
export const MCP_SERVER_NAME = "markdownbrain";
