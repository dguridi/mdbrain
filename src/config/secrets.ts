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
export interface BunSecrets {
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
 * silent demotion to a file. Neither is the mirror of it — a keychain that takes
 * a write and refuses the read of what it just took — and that one is met in
 * `configure`, which reads a key back before it calls it stored.
 */
async function openKeychain(): Promise<ConnectionKeyStore | null> {
  const secrets = bunSecrets();
  if (!secrets) return null;
  try {
    await secrets.get({ service: KEYCHAIN_SERVICE, name: `probe-${process.pid}` });
  } catch {
    return null;
  }
  return keychainStore(secrets);
}

/**
 * macOS's answer when the caller is not the one allowed to read an item.
 *
 * The sentence the platform attaches to it is *The user name or passphrase you
 * entered is not correct*, which is about a password nobody typed: it is the
 * generic text for `errSecAuthFailed`, and passing it on sends a person to check
 * credentials that are all fine. What it means here is worth saying instead,
 * which is the whole reason this constant and the two sentences beside it exist.
 */
const ERR_SEC_AUTH_FAILED = -25293;

/**
 * Whether a failure is the keychain refusing this binary, rather than anything
 * else that can go wrong in there.
 *
 * Recognised by the number rather than by the platform's prose, since the prose
 * is localised; looked for on a `code` property *and* in the message, because
 * which of the two carries it depends on how the runtime wrapped the error.
 */
function isKeychainRefusal(cause: unknown): boolean {
  const error = cause as { code?: unknown; message?: unknown } | null | undefined;
  if (typeof error?.code === "number" && error.code === ERR_SEC_AUTH_FAILED) return true;
  const message = typeof error?.message === "string" ? error.message : "";
  // The minus sign as well as the hyphen: the number arrives written the way
  // whatever raised it chose to write it.
  return /errSecAuthFailed|[-\u2212]\s?25293/.test(message);
}

/** What a refused **read** means, and the command that ends it. */
const REFUSED_READ =
  "this machine's keychain will not let this copy of mdbrain read a key an earlier copy stored " +
  "(errSecAuthFailed, -25293) — no password is wrong. Run `mdbrain configure --new-keys`, which stores the key again under this copy.";

/**
 * What a refused **write** means, which is a different fact with a different
 * remedy: an item this copy may not write cannot be replaced from in here, so it
 * has to be removed by hand before anything can be stored under that name.
 * Saying the read's sentence for a write would prescribe the very command that
 * has just failed.
 */
const refusedWrite = (agentId: string): string =>
  `this machine's keychain will not let this copy of mdbrain store a key under ${agentId} (errSecAuthFailed, -25293) — no password is wrong. ` +
  `Remove the item an earlier copy left there with \`security delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${agentId}\`, then run \`mdbrain configure --new-keys\` again.`;

/** Run one keychain call, with a refusal's platform sentence replaced by `refused`. */
async function keychainCall<T>(operation: () => Promise<T>, refused: string): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (!isKeychainRefusal(cause)) throw cause;
    throw new Error(refused, { cause });
  }
}

/**
 * Whether the item just written can be read back by this binary.
 *
 * A read that fails at all is the case the caller is asking about, so the reason
 * is not needed to answer it — and a read refusal reported from inside a write
 * would name the wrong operation and prescribe the wrong remedy.
 */
async function readsBack(secrets: BunSecrets, agentId: string, key: string): Promise<boolean> {
  try {
    return (await secrets.get({ service: KEYCHAIN_SERVICE, name: agentId })) === key;
  } catch {
    return false;
  }
}

/**
 * The keychain store itself, over whatever `Bun.secrets`-shaped API it is given.
 *
 * Separate from {@link openKeychain} so that a caller — a test — can hand in a
 * double. The two behaviours below are the ones worth holding and neither is
 * reachable through a real keychain on a machine that is not macOS: a write that
 * recreates an item it cannot read back, and a refusal said in words a person
 * can act on.
 *
 * @param secrets the keychain API to work through
 */
export function keychainStore(secrets: BunSecrets): ConnectionKeyStore {
  return {
    backend: { kind: "keychain", where: `the operating system's keychain, under "${KEYCHAIN_SERVICE}"` },
    get: (agentId) => keychainCall(() => secrets.get({ service: KEYCHAIN_SERVICE, name: agentId }), REFUSED_READ),
    // Written, then checked, and recreated only when the check says it must be.
    //
    // A write onto an item that is already there is an update: the value changes
    // and the item keeps the access control list it was created with — the list
    // of binaries allowed to read it without asking a person. `upgrade` replaces
    // this binary in place, and an unsigned build's code identity changes with
    // it, so that list can name a copy of mdbrain that no longer exists. The
    // item is then one this copy may write and may not read: a key that looks
    // stored and cannot be used. Deleting it and writing it again is the repair,
    // because an item that is created names its creator.
    //
    // **The order is the whole of the safety.** Deleting first would turn a
    // refused write from *the key that was here still works* into *there is no
    // key at all*, and would do it on every write rather than on the few that
    // need it. Writing first costs one read, and deletes only an item that has
    // just been shown to be unreadable — which holds nothing this machine could
    // have used anyway.
    set: async (agentId, key) => {
      await keychainCall(() => secrets.set({ service: KEYCHAIN_SERVICE, name: agentId, value: key }), refusedWrite(agentId));
      if (await readsBack(secrets, agentId, key)) return;
      await keychainCall(() => secrets.delete({ service: KEYCHAIN_SERVICE, name: agentId }), refusedWrite(agentId));
      await keychainCall(() => secrets.set({ service: KEYCHAIN_SERVICE, name: agentId, value: key }), refusedWrite(agentId));
    },
    forget: async (agentId) => {
      await keychainCall(() => secrets.delete({ service: KEYCHAIN_SERVICE, name: agentId }), refusedWrite(agentId));
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
