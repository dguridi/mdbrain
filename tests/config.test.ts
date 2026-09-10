import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHarness, HARNESSES } from "../src/run/harness.ts";
import { MCP_URL } from "../src/auth/project.ts";
import {
  CONFIG_VERSION,
  DEFAULT_BOUNDS,
  SESSION_CAP_HARD_MAX,
  durationMs,
  parseConfig,
  serializeConfig,
  type Config,
} from "../src/config/schema.ts";
import {
  clearDraft,
  draftPath,
  loadConfig,
  loadDraft,
  mcpConfigPath,
  saveConfig,
  saveDraft,
  syncMcpConfigs,
  writeMcpConfig,
} from "../src/config/store.ts";
import { keyStorageLine, openConnectionKeyStore, secretsPath } from "../src/config/secrets.ts";
import { DRAFT_VERSION } from "../src/configure/questions.ts";
import { configPath } from "../src/config/paths.ts";

const cwd = process.platform === "win32" ? "C:\\work\\checkout" : "/work/checkout";

const good = (over: Record<string, unknown> = {}) => ({
  version: 1,
  poll: "5m",
  sessionsPerHour: 10,
  agents: {
    "dev-bot-mdden": {
      id: "2ac346d8-aef8-453f-8cfd-e789517c716c",
      harness: "claude",
      cwd,
      env: { harness: "ANTHROPIC_API_KEY", connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" },
      bounds: { maxTurns: 50, maxBudgetUsd: 5, wallClock: "30m" },
    },
  },
  ...over,
});

const agentWith = (over: Record<string, unknown>) => good({ agents: { "dev-bot-mdden": { ...good().agents["dev-bot-mdden"], ...over } } });

const refused = (value: unknown) => {
  const reading = parseConfig(JSON.stringify(value));
  expect(reading.kind).toBe("problem");
  return reading.kind === "problem" ? reading.message : "";
};

describe("the config file's schema", () => {
  it("reads a complete file into a config", () => {
    const reading = parseConfig(JSON.stringify(good()));
    expect(reading.kind).toBe("config");
    if (reading.kind !== "config") return;
    expect(reading.config.version).toBe(CONFIG_VERSION);
    expect(reading.config.sessionsPerHour).toBe(10);
    expect(reading.config.agents["dev-bot-mdden"].bounds.wallClock).toBe("30m");
  });

  it("fills the optional fields with their defaults, and leaves the ceiling to the server when absent", () => {
    const { poll: _poll, sessionsPerHour: _cap, ...rest } = good();
    const reading = parseConfig(JSON.stringify(rest));
    expect(reading.kind).toBe("config");
    if (reading.kind !== "config") return;
    expect(reading.config.poll).toBe("5m");
    expect(reading.config.sessionsPerHour).toBeNull();
    const { bounds: _b, ...entry } = good().agents["dev-bot-mdden"];
    const withoutBounds = parseConfig(JSON.stringify(good({ agents: { "dev-bot-mdden": entry } })));
    expect(withoutBounds.kind === "config" && withoutBounds.config.agents["dev-bot-mdden"].bounds).toEqual(DEFAULT_BOUNDS);
  });

  it("105-S2: refuses a value that looks like a key where a variable's name belongs, and says where the key goes", () => {
    expect(refused(agentWith({ env: { harness: "sk-ant-api03-abcdef", connectionKey: "MDBRAIN_KEY" } }))).toMatch(/looks like a key.*variable/);
    expect(refused(agentWith({ env: { harness: "ANTHROPIC_API_KEY", connectionKey: "smd_agent_abcdef" } }))).toMatch(/env\.connectionKey/);
  });

  it("105-S3: refuses a file with no version, an unknown version, and names an upgrade for a newer one", () => {
    const { version: _v, ...noVersion } = good();
    expect(refused(noVersion)).toMatch(/no version/);
    expect(refused(good({ version: 0 }))).toMatch(/version 0/);
    expect(refused(good({ version: 2 }))).toMatch(/Upgrade mdbrain/);
    expect(refused(good({ version: "1" }))).toMatch(/whole number/);
  });

  it("105-S4: refuses an unknown harness, a relative cwd, a unitless duration, a ceiling above the cap and an empty agents map, each by name", () => {
    expect(refused(agentWith({ harness: "codex" }))).toMatch(/harness names a harness this build does not have/);
    expect(refused(agentWith({ cwd: "checkout" }))).toMatch(/cwd must be an absolute path/);
    expect(refused(agentWith({ bounds: { wallClock: "30" } }))).toMatch(/wallClock must be a duration with a unit/);
    expect(refused(good({ poll: "300" }))).toMatch(/poll must be a duration/);
    expect(refused(good({ poll: "5s" }))).toMatch(/at least 30s/);
    expect(refused(good({ sessionsPerHour: SESSION_CAP_HARD_MAX + 1 }))).toMatch(/above the server's ceiling/);
    expect(refused(good({ agents: {} }))).toMatch(/at least one agent/);
  });

  it("refuses a bare command field, because the harness's command line is the program's and not the file's", () => {
    expect(refused(agentWith({ command: "claude -p" }))).toMatch(/command is not a field/);
  });

  it("105-S44: an absent or null env.harness is the harness's own account, and is written as an absent field", () => {
    const { env: _env, ...entry } = good().agents["dev-bot-mdden"];
    const absent = parseConfig(
      JSON.stringify(good({ agents: { "dev-bot-mdden": { ...entry, env: { connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" } } } })),
    );
    expect(absent.kind === "config" && absent.config.agents["dev-bot-mdden"].env.harness).toBeNull();

    const explicitNull = parseConfig(JSON.stringify(agentWith({ env: { harness: null, connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" } })));
    expect(explicitNull.kind === "config" && explicitNull.config.agents["dev-bot-mdden"].env.harness).toBeNull();
    if (explicitNull.kind !== "config") return;

    const text = serializeConfig(explicitNull.config);
    expect(text).not.toContain('"harness": null');
    expect(JSON.parse(text).agents["dev-bot-mdden"].env).toEqual({ connectionKey: "MDBRAIN_KEY_DEV_BOT_MDDEN" });
    // And a key pasted there is still refused: choosing the account is one
    // answer, and putting a secret in the file is not the other.
    expect(refused(agentWith({ env: { harness: "sk-ant-api03-abcdef", connectionKey: "MDBRAIN_KEY" } }))).toMatch(/looks like a key/);
  });

  it("refuses a variable that is not a name, and a bounds value that is not a number", () => {
    expect(refused(agentWith({ env: { harness: "not a name", connectionKey: "OK" } }))).toMatch(/legal environment variable name/);
    expect(refused(agentWith({ bounds: { maxTurns: 0 } }))).toMatch(/maxTurns/);
    expect(refused(agentWith({ bounds: { maxBudgetUsd: -1 } }))).toMatch(/maxBudgetUsd/);
  });

  it("105-S5: tolerates a field it does not read, below one it does", () => {
    const reading = parseConfig(JSON.stringify(agentWith({ colour: "blue", bounds: { ...good().agents["dev-bot-mdden"].bounds, nice: 10 } })));
    expect(reading.kind).toBe("config");
    const top = parseConfig(JSON.stringify(good({ theme: "dark" })));
    expect(top.kind).toBe("config");
  });

  it("refuses text that is not JSON, or not an object", () => {
    expect(parseConfig("{").kind).toBe("problem");
    expect(parseConfig("[]").kind).toBe("problem");
  });

  it("writes only what it knows, in a stable order, and reads its own output back unchanged", () => {
    const reading = parseConfig(JSON.stringify(good()));
    if (reading.kind !== "config") throw new Error("not a config");
    const text = serializeConfig(reading.config);
    expect(text.startsWith('{\n  "version": 1,')).toBe(true);
    const again = parseConfig(text);
    expect(again.kind === "config" && again.config).toEqual(reading.config);
    expect(serializeConfig(reading.config)).toBe(text);
  });

  it("reads a duration with a unit and refuses one without", () => {
    expect(durationMs("5m")).toBe(300_000);
    expect(durationMs("90s")).toBe(90_000);
    expect(durationMs("2h")).toBe(7_200_000);
    expect(durationMs("300")).toBeNull();
    expect(durationMs("0m")).toBeNull();
    expect(durationMs("5 m")).toBeNull();
  });
});

describe("the config store", () => {
  let root: string;
  let previousConfig: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mdbrain-config-"));
    previousConfig = process.env.MDBRAIN_CONFIG_DIR;
    process.env.MDBRAIN_CONFIG_DIR = join(root, "config");
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.MDBRAIN_CONFIG_DIR;
    else process.env.MDBRAIN_CONFIG_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });

  const config = (): Config => {
    const reading = parseConfig(JSON.stringify(good()));
    if (reading.kind !== "config") throw new Error("not a config");
    return reading.config;
  };

  it("105-S1: writes config.json under the config root, creating the folder, and leaves no temporary file behind", async () => {
    const path = await saveConfig(config());
    expect(path).toBe(configPath());
    expect(readdirSync(join(root, "config"))).toEqual(["config.json"]);
    const loaded = await loadConfig();
    expect(loaded.kind === "config" && loaded.config).toEqual(config());
  });

  it("105-S6: the write is a temporary file renamed over the real one, so an interruption leaves the old file whole", async () => {
    await saveConfig(config());
    const before = readFileSync(configPath(), "utf8");
    // The mechanism is what is asserted: a sibling temporary file and a rename,
    // rather than an open-and-truncate of the real path. A write that failed
    // between the two would leave `before` in place and a stray `.tmp` beside it.
    const source = readFileSync(join(__dirname, "../src/config/store.ts"), "utf8");
    expect(source).toContain('`${path}.${process.pid}.tmp`');
    expect(source).toContain("await rename(temporary, path)");
    expect(source.indexOf("writeFile(temporary")).toBeLessThan(source.indexOf("rename(temporary, path)"));
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });

  it("105-S7: a file written by hand is read exactly as one configure wrote", async () => {
    const dir = join(root, "config");
    rmSync(dir, { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(good(), null, 2));
    const loaded = await loadConfig();
    expect(loaded.kind === "config" && loaded.config).toEqual(config());
  });

  it("tells absent, unreadable and refused apart", async () => {
    expect((await loadConfig()).kind).toBe("none");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(configPath(), "{ not json");
    expect((await loadConfig()).kind).toBe("problem");
    writeFileSync(configPath(), JSON.stringify(good({ version: 9 })));
    const problem = await loadConfig();
    expect(problem.kind === "problem" && problem.message).toMatch(/Upgrade mdbrain/);
  });

  it("writes one MCP file per agent under the config root, naming the variable and never a value", async () => {
    const path = await writeMcpConfig("dev-bot-mdden", "MDBRAIN_KEY_DEV_BOT_MDDEN", claudeHarness);
    expect(path).toBe(mcpConfigPath("dev-bot-mdden"));
    expect(path.startsWith(join(root, "config"))).toBe(true);
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
    expect(parsed.mcpServers["markdown-den"].type).toBe("http");
    expect(parsed.mcpServers["markdown-den"].headers.Authorization).toBe("Bearer ${MDBRAIN_KEY_DEV_BOT_MDDEN}");
    expect(text).not.toMatch(/smd_agent_/);
  });

  it("folds an agent name into a safe, prefixed, case-folded file name", () => {
    expect(mcpConfigPath("spec warden/2").endsWith(join("mcp", "agent-spec_warden_2.json"))).toBe(true);
    expect(mcpConfigPath("CON").endsWith(join("mcp", "agent-con.json"))).toBe(true);
    expect(claudeHarness.mcpConfigText("X")).toContain('"url"');
  });
  it("the MCP file's format belongs to the harness, not to the config store", () => {
    // The seam this exists to keep visible. `store.ts` decides where the file
    // goes and when it is rewritten; what is IN it is the harness's, because the
    // keys and even the syntax differ per harness and a store that wrote one
    // shape for all of them is a Claude assumption wearing a general name.
    const store = readFileSync(join(__dirname, "..", "src", "config", "store.ts"), "utf8");
    expect(store).not.toContain("mcpServers");
    expect(store).not.toContain("MCP_URL");

    // Driven off the roster rather than against `claude` by name, so a harness
    // added later arrives asserted instead of needing somebody to remember.
    for (const [id, spec] of Object.entries(HARNESSES)) {
      const text = spec.mcpConfigText("MDBRAIN_KEY_PROBE");
      // The variable's NAME and never a value: the file lives under the config
      // root and is meant to be copied, which is only safe while that holds.
      expect(text, id).toContain("${MDBRAIN_KEY_PROBE}");
      expect(text, id).toContain(MCP_URL);
      // Asserted as an ABSENCE beside the two presences above, because those
      // cannot see a harness that writes the variable AND the value: the
      // never-a-value half is the one the file's location rests on, and it is
      // the half a presence is structurally blind to. The shapes are the
      // schema's own definition of a key rather than a literal chosen here.
      expect(text, id).not.toMatch(/sk-|smd_agent_/);
    }
  });

  it("syncing writes one file per configured agent and removes the files of agents no longer configured, reporting each", async () => {
    await writeMcpConfig("gone-bot", "MDBRAIN_KEY_GONE_BOT", claudeHarness);
    const { mcpPaths, removed } = await syncMcpConfigs(config());
    expect(Object.keys(mcpPaths)).toEqual(["dev-bot-mdden"]);
    expect(existsSync(mcpPaths["dev-bot-mdden"])).toBe(true);
    expect(removed).toEqual([mcpConfigPath("gone-bot")]);
    expect(existsSync(mcpConfigPath("gone-bot"))).toBe(false);
  });

  it("an agent named __proto__ is an entry, not an assignment to the map's prototype", () => {
    // Built as text: an object literal with a `__proto__` key sets the literal's
    // prototype rather than an own property, so only JSON can spell this file.
    const entry = JSON.stringify(good().agents["dev-bot-mdden"]);
    const reading = parseConfig(`{"version":1,"agents":{"__proto__":${entry}}}`);
    expect(reading.kind).toBe("config");
    if (reading.kind !== "config") return;
    expect(Object.keys(reading.config.agents)).toEqual(["__proto__"]);
    expect(reading.config.agents["__proto__"].id).toBe("2ac346d8-aef8-453f-8cfd-e789517c716c");
  });

  it("that same name survives being WRITTEN, which is the half a parse cannot show", () => {
    const entry = JSON.stringify(good().agents["dev-bot-mdden"]);
    const reading = parseConfig(`{"version":1,"agents":{"__proto__":${entry}}}`);
    if (reading.kind !== "config") throw new Error(reading.message);

    const text = serializeConfig(reading.config);
    expect(JSON.parse(text).agents).toHaveProperty("__proto__");
    const back = parseConfig(text);
    expect(back.kind).toBe("config");
    if (back.kind !== "config") return;
    expect(Object.keys(back.config.agents)).toEqual(["__proto__"]);
  });

  it("and its connection file is kept rather than removed as a stranger's", async () => {
    const entry = JSON.stringify(good().agents["dev-bot-mdden"]);
    const reading = parseConfig(`{"version":1,"agents":{"__proto__":${entry}}}`);
    if (reading.kind !== "config") throw new Error(reading.message);

    const { mcpPaths, removed } = await syncMcpConfigs(reading.config);
    expect(Object.keys(mcpPaths)).toEqual(["__proto__"]);
    expect(removed).toEqual([]);
    expect(existsSync(mcpConfigPath("__proto__"))).toBe(true);
  });

  it("a duration a timer could not hold is refused rather than firing at once", () => {
    expect(durationMs("600h")).toBeNull();
    expect(durationMs("500h")).toBe(1_800_000_000);
  });
});

describe("the draft a configure leaves behind", () => {
  let root: string;
  let previousConfig: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mdbrain-draft-"));
    previousConfig = process.env.MDBRAIN_CONFIG_DIR;
    process.env.MDBRAIN_CONFIG_DIR = join(root, "config");
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.MDBRAIN_CONFIG_DIR;
    else process.env.MDBRAIN_CONFIG_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });

  it("105-S49: it lands beside the config, comes back as it went in, and clearing it is safe when there is none", async () => {
    expect(await loadDraft()).toBeNull();
    await saveDraft({ version: DRAFT_VERSION, chosen: ["a-1"], dropped: [], agents: { "a-1": { id: "a-1", cwd } }, sessionsPerHour: 2 });
    expect(draftPath()).toBe(join(root, "config", "configure-draft.json"));
    const back = await loadDraft();
    expect(back?.chosen).toEqual(["a-1"]);
    expect(back?.agents["a-1"].cwd).toBe(cwd);
    await clearDraft();
    expect(existsSync(draftPath())).toBe(false);
    await clearDraft();
  });

  it("holds no secret, which is what lets it sit in the config root rather than the state root", async () => {
    await saveDraft({ version: DRAFT_VERSION, chosen: ["a-1"], dropped: [], agents: { "a-1": { id: "a-1", cwd, harnessVariable: "ANTHROPIC_API_KEY" } } });
    const text = readFileSync(draftPath(), "utf8");
    expect(text).not.toMatch(/sk-|smd_agent_/);
  });
});

describe("the connection key store", () => {
  let root: string;
  let previousState: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mdbrain-secrets-"));
    previousState = process.env.MDBRAIN_STATE_DIR;
    process.env.MDBRAIN_STATE_DIR = join(root, "state");
  });

  afterEach(() => {
    if (previousState === undefined) delete process.env.MDBRAIN_STATE_DIR;
    else process.env.MDBRAIN_STATE_DIR = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  it("105-S51: with no keychain the key lands in a file under the STATE root, at 0600, and the fallback says so", async () => {
    const store = await openConnectionKeyStore(undefined, async () => null);
    expect(store.backend.kind).toBe("file");
    expect(secretsPath()).toBe(join(root, "state", "secrets.json"));
    expect(keyStorageLine(store.backend)).toMatch(/readable only by you/);

    await store.set("a-1", "smd_agent_00000000_secret");
    expect(await store.get("a-1")).toBe("smd_agent_00000000_secret");
    expect(await store.get("a-2")).toBeNull();

    // The config root must not acquire a secret, whatever the store does.
    expect(readFileSync(secretsPath(), "utf8")).toContain("smd_agent_00000000_secret");
    // 0600 is not expressible on Windows, so the mode is asserted where it means
    // something and the write is asserted everywhere.
    if (process.platform !== "win32") {
      expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
    }

    await store.set("a-2", "second");
    expect(await store.get("a-1")).toBe("smd_agent_00000000_secret");
    await store.forget("a-1");
    expect(await store.get("a-1")).toBeNull();
    expect(await store.get("a-2")).toBe("second");
  });

  it("105-S51: an unreadable store answers nothing to a read and refuses a write, rather than replacing what it could not read", async () => {
    const store = await openConnectionKeyStore(undefined, async () => null);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(secretsPath(), "not json at all");
    // A read can afford to shrug: "no key here for this agent" is true either way.
    expect(await store.get("a-1")).toBeNull();
    // A write cannot. It rewrites the whole file, so treating the corruption as
    // an empty store would delete every other agent's key without a word.
    await expect(store.set("a-1", "recovered")).rejects.toThrow(/would replace every key already in it/);
    await expect(store.forget("a-1")).rejects.toThrow(/would replace every key already in it/);
    expect(readFileSync(secretsPath(), "utf8")).toBe("not json at all");
  });

  it("105-S51: a keychain is preferred when there is one, and it is named rather than assumed", async () => {
    const held = new Map<string, string>();
    const store = await openConnectionKeyStore(undefined, async () => ({
      backend: { kind: "keychain", where: "a keychain" },
      get: async (id) => held.get(id) ?? null,
      set: async (id, key) => void held.set(id, key),
      forget: async (id) => void held.delete(id),
    }));
    expect(store.backend.kind).toBe("keychain");
    expect(keyStorageLine(store.backend)).toBe("  Connection keys are held in a keychain.");
    await store.set("a-1", "kept");
    expect(await store.get("a-1")).toBe("kept");
    expect(existsSync(secretsPath())).toBe(false);
  });
});
