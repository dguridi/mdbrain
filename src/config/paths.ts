// Where this program's files live, and why config and state are never the same
// place.
//
// Config travels: it is the thing you copy to another machine. State never does,
// and the session is the strongest example of one — a config directory copied to
// a VPS must not carry an account with it. Two directories rather than two
// filenames in one is what keeps that mistake out of reach, since copying a
// config directory can then never pick up a session by accident.

import { homedir, platform } from "node:os";
import { join } from "node:path";

/** The one place any file's location is decided, so tests can vary the environment. */
export interface PathEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

export function currentEnv(): PathEnv {
  return { platform: platform(), home: homedir(), env: process.env };
}

/**
 * The directory holding the config file, following each platform's own
 * convention rather than inventing one: `%APPDATA%` on Windows, `Application
 * Support` on macOS, `$XDG_CONFIG_HOME` (or its default) elsewhere.
 */
export function configDir(env: PathEnv = currentEnv()): string {
  if (env.env.MDBRAIN_CONFIG_DIR) return env.env.MDBRAIN_CONFIG_DIR;
  if (env.platform === "win32") {
    return join(env.env.APPDATA ?? join(env.home, "AppData", "Roaming"), "mdbrain");
  }
  if (env.platform === "darwin") {
    return join(env.home, "Library", "Application Support", "mdbrain");
  }
  return join(env.env.XDG_CONFIG_HOME ?? join(env.home, ".config"), "mdbrain");
}

/**
 * The directory holding state, which is a different root from {@link configDir}
 * on Windows and Linux — so that copying a config directory cannot carry a
 * session with it.
 *
 * **On macOS it is not a different root**, and a reader should meet that here
 * rather than by copying a directory: `Application Support/mdbrain/state` is a
 * child of `Application Support/mdbrain`, so a copied config root does carry the
 * session. It is the convention macOS leaves for state, and changing it moves
 * where an installed runner looks; it is pinned by a test rather than fixed in
 * passing.
 */
export function stateDir(env: PathEnv = currentEnv()): string {
  if (env.env.MDBRAIN_STATE_DIR) return env.env.MDBRAIN_STATE_DIR;
  if (env.platform === "win32") {
    return join(env.env.LOCALAPPDATA ?? join(env.home, "AppData", "Local"), "mdbrain");
  }
  if (env.platform === "darwin") {
    return join(env.home, "Library", "Application Support", "mdbrain", "state");
  }
  return join(env.env.XDG_STATE_HOME ?? join(env.home, ".local", "state"), "mdbrain");
}

export function configPath(env: PathEnv = currentEnv()): string {
  return join(configDir(env), "config.json");
}

/**
 * The signed-in session, under the state root and nowhere else.
 *
 * One file for one account: the runner acts as one person per machine, because an
 * organization is not an account — one account already belongs to as many
 * organizations as it has been added to.
 */
export function sessionPath(env: PathEnv = currentEnv()): string {
  return join(stateDir(env), "session.json");
}
