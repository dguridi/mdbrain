// The one markdown-den this CLI talks to.
//
// Production, and only production. There is no environment variable and no flag,
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
 * **`www.` is load-bearing and must not be tidied away.** The apex answers
 * `https://markdown-den.com/api/…` with a `308` to this host, and a redirect
 * that crosses origins **drops the `Authorization` header** — so a request sent
 * to the apex arrives with no credential and is refused as though the person
 * were signed out. A valid token and a malformed one come back byte-identical,
 * which makes it about as misleading as a failure can be.
 *
 * It went unnoticed for as long as it did because **nothing sent a bearer here
 * until `run` did**: the login only opens a page in a browser, which follows the
 * redirect and carries no header of ours.
 */
export const APP_URL = "https://www.markdown-den.com";

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
 */
export const MCP_URL = "https://mcp.markdown-den.com/mcp";

/**
 * The name that server is given inside the per-agent MCP file.
 *
 * It lives beside the address because two modules must agree on it and neither
 * owns it: `store.ts` writes it as the key under `mcpServers`, and `harness.ts`
 * names the harness's tools after it when it grants the session the one server
 * it was handed. Written twice, the session would be granted tools no server
 * offers and refused the ones it needs, and nothing would say so.
 */
export const MCP_SERVER_NAME = "markdown-den";
