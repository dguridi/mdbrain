import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type { KeyRow } from "../src/auth/api.ts";
import type { CommandContext } from "../src/cli.ts";
import type { AgentEntry, Config } from "../src/config/schema.ts";
import type { ConnectionKeyStore } from "../src/config/secrets.ts";
import { configPath, stateDir } from "../src/config/paths.ts";
import { AGENTS_USAGE, needsYesMessage, runAgents, type AgentsDeps } from "../src/commands/agents.ts";
import { noConfigMessage } from "../src/commands/run.ts";
import { agentsBrowser, type BrowserPlan } from "../src/agents/screen.ts";
import { BROWSER_BINDINGS, browserActionFor, browserHints } from "../src/agents/keys.ts";
import { retireKey } from "../src/agents/retire.ts";
import {
  readProbe,
  verdictFor,
  verdictSentence,
  type OwnerView,
  type Probe,
} from "../src/agents/verdict.ts";

const cwd = process.platform === "win32" ? "C:\\work\\checkout" : "/work/checkout";

const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  id: "agent-1",
  harness: "claude",
  pollsWork: true,
  cwd,
  env: { harness: null, connectionKey: "MDBRAIN_KEY_BOT" },
  bounds: { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" },
  ...over,
});

const config = (agents: Record<string, AgentEntry>): Config => ({ version: 1, sessionsPerHour: null, agents });

const OLD_KEY = "smd_agent_ab12cd34_thesecretpart";
const NEW_KEY = "smd_agent_99887766_freshsecret";

const keyRow = (over: Partial<KeyRow> = {}): KeyRow => ({
  id: "key-row-1",
  key_prefix: "ab12cd34",
  created_at: "2026-10-01T10:00:00Z",
  last_used_at: null,
  revoked_at: null,
  ...over,
});

const owner = (over: Partial<OwnerView> = {}): OwnerView => ({
  agents: [{ id: "agent-1", org_id: "org-1", display_name: "bot", status: "active" }],
  ownedOrgIds: new Set(["org-1"]),
  ...over,
});

/** Everything the command did that writes, in order, so a test can read the sequence back. */
type Event =
  | "save-config"
  | "remove-config"
  | `remove-mcp:${string}`
  | `set:${string}`
  | `forget:${string}`
  | `mint:${string}`
  | `revoke:${string}`
  | `owner-view`
  | `present`;

function harness(over: Partial<AgentsDeps> = {}, seed: Record<string, string> = { "agent-1": OLD_KEY }) {
  const events: Event[] = [];
  const held = new Map(Object.entries(seed));
  const store: ConnectionKeyStore = {
    backend: { kind: "keychain", where: "the keychain" },
    get: async (id) => held.get(id) ?? null,
    set: async (id, key) => {
      events.push(`set:${id}`);
      held.set(id, key);
    },
    forget: async (id) => {
      events.push(`forget:${id}`);
      held.delete(id);
    },
  };
  let saved: Config | null = null;
  const out: string[] = [];
  const err: string[] = [];
  const context = (positional: string[] = [], flags: Record<string, string | boolean> = {}): CommandContext => ({
    positional,
    flags,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  const deps: AgentsDeps = {
    isTTY: false,
    env: {},
    loadConfiguration: async () => ({ kind: "config", config: config({ bot: entry(), other: entry({ id: "agent-2" }) }) }),
    openKeyStore: async () => store,
    session: async () => ({ kind: "ready", accessToken: "person-token" }),
    present: async () => {
      events.push("present");
      return { status: 200, whoami: JSON.stringify({ workspaces: [{ name: "markdown brain" }] }) };
    },
    ownerView: async () => {
      events.push("owner-view");
      return owner();
    },
    listKeys: async () => [keyRow()],
    revoke: async (_token, keyId) => {
      events.push(`revoke:${keyId}`);
    },
    mint: async (_token, id) => {
      events.push(`mint:${id}`);
      return NEW_KEY;
    },
    saveConfiguration: async (c) => {
      events.push("save-config");
      saved = c;
      return configPath();
    },
    removeConfiguration: async () => {
      events.push("remove-config");
    },
    removeMcpFile: async (name) => {
      events.push(`remove-mcp:${name}`);
      return name;
    },
    browse: async () => {},
    confirm: async () => true,
    ...over,
  };
  return { deps, events, held, out, err, context, saved: () => saved };
}

let root: string;
let previous: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mdbrain-agents-"));
  previous = { config: process.env.MDBRAIN_CONFIG_DIR, state: process.env.MDBRAIN_STATE_DIR };
  process.env.MDBRAIN_CONFIG_DIR = join(root, "config");
  process.env.MDBRAIN_STATE_DIR = join(root, "state");
});
afterEach(() => {
  for (const [key, name] of [["config", "MDBRAIN_CONFIG_DIR"], ["state", "MDBRAIN_STATE_DIR"]] as const) {
    if (previous[key] === undefined) delete process.env[name];
    else process.env[name] = previous[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("agents: the report", () => {
  it("158-S7: with no terminal it prints where everything is and every agent's fields, the key only as its prefix", async () => {
    const h = harness({ env: { MDBRAIN_CONFIG_DIR: "set" } });
    expect(await runAgents(h.deps, h.context())).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(`Configuration: ${configPath()} (moved here by MDBRAIN_CONFIG_DIR)`);
    expect(text).toContain(`State: ${stateDir()}`);
    expect(text).toContain("Connection keys are held in the keychain.");
    expect(text).toContain("id agent-1");
    expect(text).toContain(`harness claude, in ${cwd}`);
    expect(text).toContain("asked for work by mdbrain run");
    expect(text).toContain("thinks with this machine's own Claude Code account");
    expect(text).toContain("bounds: 50 turns, $5, 30m a session");
    expect(text).toContain("key smd_agent_ab12cd34…");
    // The other agent holds no key here, and says so rather than saying nothing.
    expect(text).toContain("no key on this machine");
    expect(text).not.toContain("thesecretpart");
    expect(h.events).toEqual([]);
  });

  it("158-S8: with no config it prints the paths and the no-config sentence, and exits 1", async () => {
    const h = harness({ loadConfiguration: async () => ({ kind: "none" }) });
    expect(await runAgents(h.deps, h.context())).toBe(1);
    expect(h.out.join("\n")).toContain(`Configuration: ${configPath()}`);
    expect(h.err).toEqual([noConfigMessage(configPath())]);
  });

  it("refuses a subcommand it does not have, naming the three it does", async () => {
    const h = harness();
    expect(await runAgents(h.deps, h.context(["chek"]))).toBe(1);
    expect(h.err).toEqual([AGENTS_USAGE]);
  });
});

describe("agents: the verdict", () => {
  const bot = { name: "bot", id: "agent-1", configuredIds: new Set(["agent-1"]) };
  const refused: Probe = { kind: "refused" };

  it("158-S9: a key the server answers with a whoami body is accepted, with the bot's brains", () => {
    const probe = readProbe({ status: 200, whoami: JSON.stringify({ workspaces: [{ name: "markdown brain" }, { name: "notes" }] }) });
    expect(probe).toEqual({ kind: "accepted", brains: ["markdown brain", "notes"] });
    expect(verdictSentence("bot", verdictFor(probe, bot, "ab12cd34", null, null))).toBe("accepted, in markdown brain, notes");

    const alone = verdictFor(readProbe({ status: 200, whoami: JSON.stringify({ workspaces: [] }) }), bot, null, null, null);
    expect(verdictSentence("bot", alone)).toBe("accepted, but no brain shares it: it will find no work");
  });

  it("158-S10: two managed namesakes are not guessed between, which is configure's rule for a carry-over too", () => {
    const twins = owner({
      agents: [
        { id: "agent-a", org_id: "org-1", display_name: "bot", status: "active" },
        { id: "agent-b", org_id: "org-1", display_name: "bot", status: "active" },
      ],
    });
    expect(verdictFor(refused, bot, "ab12cd34", twins, null)).toEqual({ kind: "refused", cause: { kind: "deleted" } });
  });

  it("158-S10: a namesake this machine already configures is another entry renamed, so the entry is deleted, as configure lists it", async () => {
    // dev-bot (agent-1) was renamed onto the name of a deleted agent this machine
    // also configures. configure offers no carry-over here, so check must not send
    // the person to one.
    const h = harness(
      {
        present: async () => ({ status: 401, whoami: null }),
        loadConfiguration: async () => ({
          kind: "config",
          config: config({ "dev-bot": entry(), "dev-bot-mdden": entry({ id: "agent-old" }) }),
        }),
        ownerView: async () => owner({ agents: [{ id: "agent-1", org_id: "org-1", display_name: "dev-bot-mdden", status: "active" }] }),
      },
      { "agent-old": OLD_KEY },
    );
    expect(await runAgents(h.deps, h.context(["check", "dev-bot-mdden"]))).toBe(1);
    expect(h.out).toEqual(["dev-bot-mdden: refused: agent deleted in markdown-den: mdbrain agents remove dev-bot-mdden"]);
  });

  it("158-S10: a refused key whose id is gone while a managed agent has its name is recreated; with no namesake, deleted", () => {
    const recreated = owner({ agents: [{ id: "agent-new", org_id: "org-1", display_name: "bot", status: "active" }] });
    expect(verdictFor(refused, bot, "ab12cd34", recreated, null)).toEqual({ kind: "refused", cause: { kind: "recreated" } });
    expect(verdictSentence("bot", verdictFor(refused, bot, "ab12cd34", recreated, null))).toContain("run mdbrain configure");

    // A namesake in an organization this account does not own is not one it could carry over to.
    const theirs = owner({ agents: [{ id: "agent-new", org_id: "org-9", display_name: "bot", status: "active" }] });
    expect(verdictFor(refused, bot, "ab12cd34", theirs, null)).toEqual({ kind: "refused", cause: { kind: "deleted" } });
    expect(verdictSentence("bot", verdictFor(refused, bot, "ab12cd34", owner({ agents: [] }), null))).toBe(
      "refused: agent deleted in markdown-den: mdbrain agents remove bot",
    );
  });

  it("158-S11: a refused key whose agent is disabled says so, ahead of anything about the key", () => {
    const disabled = owner({ agents: [{ id: "agent-1", org_id: "org-1", display_name: "bot", status: "disabled" }] });
    expect(verdictFor(refused, bot, "ab12cd34", disabled, [keyRow({ revoked_at: "2026-10-02T00:00:00Z" })])).toEqual({
      kind: "refused",
      cause: { kind: "disabled" },
    });
    // And an agent in an organization this account no longer owns is that, before it is disabled.
    const notMine = owner({ ownedOrgIds: new Set() });
    expect(verdictFor(refused, bot, "ab12cd34", notMine, null)).toEqual({ kind: "refused", cause: { kind: "not-owner" } });
  });

  it("158-S12: a refused key listed with revoked_at is revoked on that date; a prefix not listed is unknown", () => {
    const revoked = verdictFor(refused, bot, "ab12cd34", owner(), [keyRow({ revoked_at: "2026-10-12T08:30:00Z" })]);
    expect(verdictSentence("bot", revoked)).toBe("refused: key revoked on 2026-10-12: mdbrain agents renew bot");

    const unknown = verdictFor(refused, bot, "ab12cd34", owner(), [keyRow({ key_prefix: "00000000" })]);
    expect(verdictSentence("bot", unknown, "ab12cd34")).toContain("smd_agent_ab12cd34… is not one markdown-den knows for this agent");

    // Listed and live, refused anyway: the runner says it cannot see why rather than guessing.
    expect(verdictFor(refused, bot, "ab12cd34", owner(), [keyRow()])).toEqual({ kind: "refused", cause: { kind: "unexplained" } });
  });

  it("158-S13: a refused key with no ready session says to sign in, and makes no roster read", async () => {
    const h = harness({
      present: async () => ({ status: 401, whoami: null }),
      session: async () => ({ kind: "stop", reason: "sign-in", message: "Not signed in." }),
    });
    expect(await runAgents(h.deps, h.context(["check", "bot"]))).toBe(1);
    expect(h.out).toEqual(["bot: refused: sign in with mdbrain login to learn why"]);
    expect(h.events).not.toContain("owner-view");
  });

  it("158-S14: an unreachable server is could-not-check, never refused; nor is any other status", async () => {
    const h = harness({ present: async () => { throw new TypeError("fetch failed"); } });
    expect(await runAgents(h.deps, h.context(["check", "bot"]))).toBe(1);
    expect(h.out).toEqual(["bot: could not check: fetch failed"]);
    expect(readProbe({ status: 502, whoami: null })).toEqual({ kind: "unchecked", reason: "the server answered HTTP 502" });
    expect(readProbe({ status: 403, whoami: null }).kind).toBe("unchecked");
  });

  it("158-S17: check exits 0 only when every agent is accepted", async () => {
    const all = harness({}, { "agent-1": OLD_KEY, "agent-2": NEW_KEY });
    expect(await runAgents(all.deps, all.context(["check"]))).toBe(0);
    expect(all.out).toEqual(["bot: accepted, in markdown brain", "other: accepted, in markdown brain"]);

    // `other` holds no key here, which is not accepted.
    const one = harness();
    expect(await runAgents(one.deps, one.context(["check"]))).toBe(1);
    expect(one.out).toContain("other: no key on this machine: run mdbrain agents renew other");
  });
});

describe("agents: remove", () => {
  it("158-S18: removes the entry, its connection file, revokes its key by prefix and forgets it, and leaves the other agent", async () => {
    const h = harness();
    expect(await runAgents(h.deps, h.context(["remove", "bot"], { yes: true }))).toBe(0);
    expect(Object.keys(h.saved()!.agents)).toEqual(["other"]);
    expect(h.saved()!.agents.other).toEqual(entry({ id: "agent-2" }));
    // The config before the file it names, the revoke after both, the local key last.
    expect(h.events).toEqual(["save-config", "remove-mcp:bot", "owner-view", "revoke:key-row-1", "forget:agent-1"]);
    expect(h.out.join("\n")).toContain("the key smd_agent_ab12cd34… was revoked in markdown-den");
  });

  it("158-S19: removing the last agent deletes config.json rather than writing it empty", async () => {
    const h = harness({ loadConfiguration: async () => ({ kind: "config", config: config({ bot: entry() }) }) });
    expect(await runAgents(h.deps, h.context(["remove", "bot"], { yes: true }))).toBe(0);
    expect(h.events).toContain("remove-config");
    expect(h.events).not.toContain("save-config");
  });

  it("158-S20: signed out, the local removal stands, exits 0, and names the key as still live", async () => {
    const h = harness({ session: async () => ({ kind: "stop", reason: "sign-in", message: "Not signed in." }) });
    expect(await runAgents(h.deps, h.context(["remove", "bot"], { yes: true }))).toBe(0);
    expect(h.events).toEqual(["save-config", "remove-mcp:bot", "forget:agent-1"]);
    expect(h.out.join("\n")).toContain("the key smd_agent_ab12cd34… is still live in markdown-den; revoke it on the agent's page");
  });

  it("158-S18: a deleted agent's key is not revoked, since its keys went with it", async () => {
    const h = harness({ ownerView: async () => owner({ agents: [] }) });
    expect(await runAgents(h.deps, h.context(["remove", "bot"], { yes: true }))).toBe(0);
    expect(h.events.some((e) => e.startsWith("revoke:"))).toBe(false);
    expect(h.out.join("\n")).toContain("bot is gone from markdown-den, and its keys with it");
  });

  it("158-S21: with no terminal and no --yes it writes nothing and names the flag", async () => {
    const h = harness();
    expect(await runAgents(h.deps, h.context(["remove", "bot"]))).toBe(1);
    expect(h.err).toEqual([needsYesMessage("remove")]);
    expect(h.events).toEqual([]);
  });

  it("at a terminal it shows the plan first, and a no writes nothing", async () => {
    let shown: string[] = [];
    const h = harness({ isTTY: true, confirm: async (lines) => { shown = lines; return false; } });
    expect(await runAgents(h.deps, h.context(["remove", "bot"]))).toBe(1);
    expect(shown.join("\n")).toContain("the key smd_agent_ab12cd34… is forgotten on this machine and revoked in markdown-den");
    expect(shown.join("\n")).toContain("stays in markdown-den");
    expect(h.events).toEqual([]);
  });
});

describe("agents: the writers take a whole name and ask first", () => {
  it("158-S25: a prefix that would pick out one agent is not enough to remove or renew it", async () => {
    for (const sub of ["remove", "renew"]) {
      const h = harness();
      expect(await runAgents(h.deps, h.context([sub, "bo"], { yes: true }))).toBe(1);
      expect(h.err[0]).toContain("It needs the whole name: did you mean bot?");
      expect(h.events).toEqual([]);
    }
    // While check, which writes nothing, still takes one.
    const reading = harness();
    await runAgents(reading.deps, reading.context(["check", "bo"]));
    expect(reading.out[0]).toMatch(/^bot: /);
  });

  it("158-S26: renew with no terminal and no --yes writes nothing and names the flag", async () => {
    const h = harness();
    expect(await runAgents(h.deps, h.context(["renew", "bot"]))).toBe(1);
    expect(h.err).toEqual([needsYesMessage("renew")]);
    expect(h.events).toEqual([]);
  });

  it("158-S26: renew at a terminal shows the key it will revoke, and a no writes nothing", async () => {
    let shown: string[] = [];
    const h = harness({ isTTY: true, confirm: async (lines) => { shown = lines; return false; } });
    expect(await runAgents(h.deps, h.context(["renew", "bot"]))).toBe(1);
    expect(shown.join("\n")).toContain("the key it replaces, smd_agent_ab12cd34…, is revoked in markdown-den");
    expect(h.events).toEqual([]);
  });
});

describe("agents: a key store that will not read", () => {
  const locked = () => {
    const h = harness();
    const open = h.deps.openKeyStore;
    h.deps.openKeyStore = async () => {
      const store = await open();
      return { ...store, get: async () => { throw new Error("the keychain is locked"); } };
    };
    return h;
  };

  it("158-S27: check says it could not check rather than telling a person to renew", async () => {
    const h = locked();
    expect(await runAgents(h.deps, h.context(["check", "bot"]))).toBe(1);
    expect(h.out).toEqual(["bot: could not check: the key store could not be read (the keychain is locked)"]);
  });

  it("158-S27: renew stops before minting, so a key it cannot read is never replaced unrevoked", async () => {
    const h = locked();
    expect(await runAgents(h.deps, h.context(["renew", "bot"], { yes: true }))).toBe(1);
    expect(h.events).toEqual([]);
  });

  it("158-S27: remove still removes, and says the key was neither revoked nor forgotten", async () => {
    const h = locked();
    expect(await runAgents(h.deps, h.context(["remove", "bot"], { yes: true }))).toBe(0);
    expect(h.events).toEqual(["save-config", "remove-mcp:bot", "owner-view"]);
    expect(h.out.join("\n")).toContain("so it was neither revoked nor forgotten");
  });
});

describe("agents: renew", () => {
  it("158-S22: the new key is stored and read back before the old prefix is revoked", async () => {
    const h = harness();
    expect(await runAgents(h.deps, h.context(["renew", "bot"], { yes: true }))).toBe(0);
    expect(h.events).toEqual(["mint:agent-1", "set:agent-1", "revoke:key-row-1"]);
    expect(h.held.get("agent-1")).toBe(NEW_KEY);
    expect(h.out.join("\n")).toContain("the key smd_agent_ab12cd34… was revoked in markdown-den");
  });

  it("158-S22: a failed mint leaves the old key in the store and live on the server", async () => {
    const h = harness({ mint: async () => { throw new Error("Agent not found"); } });
    expect(await runAgents(h.deps, h.context(["renew", "bot"], { yes: true }))).toBe(1);
    expect(h.held.get("agent-1")).toBe(OLD_KEY);
    expect(h.events.some((e) => e.startsWith("revoke:"))).toBe(false);
    expect(h.err.join("\n")).toContain("The key already here (smd_agent_ab12cd34…) was kept.");
  });

  it("158-S22: a key that will not read back is not called stored, and the old one is not revoked", async () => {
    const h = harness();
    const store = await h.deps.openKeyStore();
    const reads = store.get;
    let calls = 0;
    store.get = async (id) => (++calls > 1 ? "smd_agent_00000000_wrong" : reads(id));
    expect(await runAgents(h.deps, h.context(["renew", "bot"], { yes: true }))).toBe(1);
    expect(h.events.some((e) => e.startsWith("revoke:"))).toBe(false);
  });
});

describe("agents: retiring a key", () => {
  const calls = (rows: KeyRow[], revoked: string[] = []) => ({
    listKeys: async () => rows,
    revoke: async (_token: string, id: string) => { revoked.push(id); },
  });

  it("skips a key already revoked, and one the server does not know", async () => {
    expect(await retireKey(calls([keyRow({ revoked_at: "2026-10-01T00:00:00Z" })]), "t", "agent-1", "ab12cd34")).toMatchObject({ kind: "nothing" });
    expect(await retireKey(calls([keyRow({ key_prefix: "11111111" })]), "t", "agent-1", "ab12cd34")).toMatchObject({ kind: "nothing" });
  });

  it("reports a revoke that fails as still live, never as done", async () => {
    const failing = { listKeys: async () => [keyRow()], revoke: async () => { throw new Error("permission denied"); } };
    expect(await retireKey(failing, "t", "agent-1", "ab12cd34")).toEqual({ kind: "live", prefix: "ab12cd34", problem: "permission denied" });
  });

  it("a refusal that echoes the person's bearer is redacted before it can be printed", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwZXJzb24ifQ.c2lnbmF0dXJlLXBhcnQ";
    const echoing = { listKeys: async () => [keyRow()], revoke: async () => { throw new Error(`proxy said: Authorization: Bearer ${jwt}`); } };
    const retirement = await retireKey(echoing, "t", "agent-1", "ab12cd34");
    expect(retirement.kind).toBe("live");
    expect(JSON.stringify(retirement)).not.toContain(jwt);
    expect(JSON.stringify(retirement)).toContain("[redacted]");
  });
});

describe("agents: the browser", () => {
  const tick = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 25));
  };

  it("158-S24: opening the browser and pressing nothing writes nothing, while every agent is checked", async () => {
    let frame = "";
    const h = harness({
      isTTY: true,
      browse: async (plan) => {
        const app = render(agentsBrowser(plan));
        await tick();
        frame = app.lastFrame() ?? "";
        app.unmount();
      },
    });
    expect(await runAgents(h.deps, h.context())).toBe(0);
    expect(h.events.filter((e) => e !== "present")).toEqual([]);
    expect(h.events.filter((e) => e === "present")).toHaveLength(1);
    expect(frame).toContain("bot");
    expect(frame).toContain("✓ accepted");
    expect(frame).toContain("✗ no key");
    expect(frame).toContain("key smd_agent_ab12cd34…");
    expect(frame).not.toContain("thesecretpart");
  });

  it("d shows the plan and only y goes ahead; any other key backs out", async () => {
    let plan: BrowserPlan | null = null;
    const h = harness({ isTTY: true, browse: async (p) => { plan = p; } });
    await runAgents(h.deps, h.context());
    const app = render(agentsBrowser(plan!));
    await tick();
    app.stdin.write("d");
    await tick();
    expect(app.lastFrame()).toContain("Removing bot from this machine");
    app.stdin.write("n");
    await tick();
    expect(h.events.filter((e) => e !== "present")).toEqual([]);
    app.stdin.write("d");
    await tick();
    app.stdin.write("y");
    await tick();
    expect(h.events).toContain("save-config");
    expect(h.events).toContain("remove-mcp:bot");
    app.unmount();
  });

  it("the hint line names every key the table binds, and only those", () => {
    const hints = browserHints();
    for (const binding of BROWSER_BINDINGS) expect(hints).toContain(binding.label);
    expect(browserActionFor("x", { ctrl: false, upArrow: false, downArrow: false, escape: false })).toBeNull();
    expect(browserActionFor("c", { ctrl: true, upArrow: false, downArrow: false, escape: false })).toBe("quit");
    expect(browserActionFor("c", { ctrl: false, upArrow: false, downArrow: false, escape: false })).toBe("check");
  });
});
