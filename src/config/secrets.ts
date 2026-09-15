// The one secret this program keeps: an agent's markdown-den connection key,
// as the server minted it.
//
// It exists because `configure` now asks the server for the key rather than
// asking a person to fetch one and paste it, and a key that is received has to
// be put somewhere. Where is the whole of this module's design:
//
// - **Never in `config.json`.** That file is the thing people copy between
//   machines; a credential in it travels with the copy. The store lives under
//   the **state** root, which is the root that does not travel.
// - **The OS keychain when there is one**, through `Bun.secrets` — the same
//   place `gh` and `glab` put a token. It is part of the Bun runtime the binary
//   is compiled from, so it is a keychain with no native module and no new
//   dependency.
// - **A file at `0600` when there is not**, which is the headless Linux box with
//   no keyring daemon, and the plain `node src/main.ts` run. That fallback is
//   the reason {@link ConnectionKeyStore.backend} exists: a secret must never
//   land in a plaintext file in silence, so every caller can say which of the
//   two it got, and `configure` does.
//
// Keyed by the agent's **id**, not its name: a renamed agent is the same agent
// and must not lose its key, which is the same reason the config records an id
// at all.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateDir, type PathEnv } from "./paths.ts";

/** The service name the keychain entries are grouped under. */
const KEYCHAIN_SERVICE = "mdbrain";

/** Where a key was actually put, so a caller can say it out loud. */
export type SecretBackend =
  | { kind: "keychain"; where: string }
  | { kind: "file"; where: string; reason: string };

/** What `Bun.secrets` offers, declared rather than imported: this file also runs under Node. */
interface BunSecrets {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<unknown>;
}

/** The store, as the rest of the program sees it. */
export interface ConnectionKeyStore {
  /** Where this store puts things, decided once when it is opened. */
  backend: SecretBackend;
  get(agentId: string): Promise<string | null>;
  set(agentId: string, key: string): Promise<void>;
  forget(agentId: string): Promise<void>;
}

/** The file the fallback writes, under the state root and nowhere else. */
export function secretsPath(env?: PathEnv): string {
  return join(stateDir(env), "secrets.json");
}

function bunSecrets(): BunSecrets | null {
  const bun = (globalThis as { Bun?: { secrets?: BunSecrets } }).Bun;
  const secrets = bun?.secrets;
  return secrets && typeof secrets.get === "function" && typeof secrets.set === "function" ? secrets : null;
}

/**
 * The keychain store, or null when this runtime has no keychain to offer.
 *
 * The probe is a real round trip rather than a feature check, because the two
 * failures that matter — a runtime without `secrets`, and a machine whose keyring
 * daemon is not running — look identical from the outside and only the second
 * needs the fallback. **It is a read, not a write**: a read of a name that is not
 * there answers null on every platform, while a write is the operation a macOS
 * keychain can put a permission dialog in front of, and a dialog raised merely to
 * find out whether the keychain works is a dialog raised for nothing.
 *
 * A keychain that reads and refuses to write is therefore not caught here. That
 * is deliberate: the failure surfaces where the key is actually stored, named and
 * against the agent it belongs to, which is a better place to meet it than a
 * silent demotion to a file.
 */
async function openKeychain(): Promise<ConnectionKeyStore | null> {
  const secrets = bunSecrets();
  if (!secrets) return null;
  try {
    await secrets.get({ service: KEYCHAIN_SERVICE, name: `probe-${process.pid}` });
  } catch {
    return null;
  }
  return {
    backend: { kind: "keychain", where: `the operating system's keychain, under "${KEYCHAIN_SERVICE}"` },
    get: (agentId) => secrets.get({ service: KEYCHAIN_SERVICE, name: agentId }),
    set: async (agentId, key) => {
      await secrets.set({ service: KEYCHAIN_SERVICE, name: agentId, value: key });
    },
    forget: async (agentId) => {
      await secrets.delete({ service: KEYCHAIN_SERVICE, name: agentId });
    },
  };
}

/** What the fallback file holds: agent id to key, and nothing else. */
type SecretsFile = Record<string, string>;

/**
 * What a read of the file found. *Corrupt* is a third answer rather than an
 * empty one, and the distinction is the whole of why this type exists: a write
 * here is a read-modify-write of the **whole** file, so treating a torn file as
 * empty and then saving would delete every other agent's key without a word.
 */
type SecretsRead = { kind: "read"; contents: SecretsFile } | { kind: "corrupt" };

async function readSecretsFile(path: string): Promise<SecretsRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "read", contents: {} };
    throw cause;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "corrupt" };
    const contents: SecretsFile = {};
    for (const [id, key] of Object.entries(value as Record<string, unknown>)) {
      if (typeof key === "string") contents[id] = key;
    }
    return { kind: "read", contents };
  } catch {
    return { kind: "corrupt" };
  }
}

/** The sentence for a store that cannot be written without losing what is in it. */
function corruptStore(path: string): Error {
  return new Error(
    `${path} is not readable as a key store, and writing to it would replace every key already in it. Move it aside and run mdbrain configure again to mint fresh keys.`,
  );
}

/**
 * Rewrite the whole file, atomically and at `0600`.
 *
 * The mode is set on the temporary file **before** the rename, so the secret is
 * never briefly readable at the umask's default; `writeFile`'s own `mode` is
 * ignored when the file already exists, which is why it is a separate `chmod`.
 */
async function writeSecretsFile(path: string, contents: SecretsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function openFileStore(path: string, reason: string): ConnectionKeyStore {
  return {
    backend: { kind: "file", where: path, reason },
    // A read tolerates a corrupt file, because the answer *this agent has no
    // key here* is true either way and the remedy is to mint one. A write does
    // not, because it would carry out that remedy for one agent by destroying
    // every other agent's.
    async get(agentId) {
      const read = await readSecretsFile(path);
      return read.kind === "read" ? (read.contents[agentId] ?? null) : null;
    },
    async set(agentId, key) {
      const read = await readSecretsFile(path);
      if (read.kind === "corrupt") throw corruptStore(path);
      read.contents[agentId] = key;
      await writeSecretsFile(path, read.contents);
    },
    async forget(agentId) {
      const read = await readSecretsFile(path);
      if (read.kind === "corrupt") throw corruptStore(path);
      if (!(agentId in read.contents)) return;
      delete read.contents[agentId];
      await writeSecretsFile(path, read.contents);
    },
  };
}

/**
 * Open the store this machine can offer, preferring the keychain.
 *
 * @param env the path environment, so a test can put the fallback somewhere of its own
 * @param keychain the keychain probe, so a test can force either branch
 */
export async function openConnectionKeyStore(
  env?: PathEnv,
  keychain: () => Promise<ConnectionKeyStore | null> = openKeychain,
): Promise<ConnectionKeyStore> {
  const found = await keychain();
  if (found) return found;
  return openFileStore(
    secretsPath(env),
    bunSecrets() ? "this machine's keychain refused to hold it" : "this runtime has no keychain to put it in",
  );
}

/**
 * The sentence a caller says about where a key ended up.
 *
 * **Which of the two branches is worth saying is the caller's to decide, and
 * the two callers decide differently.** `configure` says it every time, because
 * somebody is standing there asking and a key going into the keychain is part of
 * the answer. `run` says it only on the file fallback: a line on every start
 * that tells a person what they already assumed is the kind of furniture that
 * makes the lines beside it harder to find, and the fallback branch is the one
 * that is news — it is the only surface in the program that says connection keys
 * are sitting in a plaintext file.
 */
export function keyStorageLine(backend: SecretBackend): string {
  return backend.kind === "keychain"
    ? `  Connection keys are held in ${backend.where}.`
    : `  Connection keys are held in ${backend.where}, readable only by you — ${backend.reason}.`;
}
