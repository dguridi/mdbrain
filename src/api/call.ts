// What `mdbrain call`, `read` and `upload` decide, with no socket, disk or clock.
//
// The HTTP API publishes its own catalogue — every operation's route and the
// JSON Schema of its arguments — so this program carries no copy of the
// operation list. Everything here reads that catalogue: how a typed `--flag` is
// turned into the value its argument declares, how an argument object becomes a
// request, when arguments are too large for a body and must be staged, which
// exit code an answer earns, and which workspace a typed name means. Keeping it
// pure is what lets each of those be tested as a table rather than through a
// server.

/** A JSON Schema as the catalogue writes one: only the parts read here. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
}

/** One operation as `GET /v1/operations` lists it. */
export interface CatalogueEntry {
  name: string;
  method: string;
  path: string;
  writes?: boolean;
  actors?: string[];
  input_schema?: JsonSchema;
}

/**
 * The exit codes every API command answers with. A script branches on these, so
 * each one means one kind of outcome and nothing else: the server said no, the
 * invocation was wrong before anything was sent, the key is missing or refused,
 * the key is out of requests, or no usable answer came back at all.
 */
export const EXIT = {
  ok: 0,
  refused: 1,
  usage: 2,
  auth: 3,
  limited: 4,
  transport: 5,
} as const;

/** The routes `read`, `upload` and argument staging stand on. These are the
 *  API's fixed addresses rather than a copy of the catalogue: `call` reads the
 *  catalogue because it must reach any operation, while these three commands
 *  reach only these, and a catalogue read each would spend a request of the
 *  key's rate for nothing. */
export const ROUTES = {
  operations: "/operations",
  workspaces: "/workspaces",
  readFile: "/file",
  beginUpload: "/uploads",
  uploadImage: "/images",
} as const;

/** The header naming a staged upload in place of a request body. */
export const ARGUMENTS_UPLOAD_HEADER = "X-Arguments-Upload";

/** Above this many bytes of serialised arguments, `call` stages them rather than
 *  sending a body. It is the API's own body limit, so a body this program sends
 *  is never one the server would refuse for its size. */
export const STAGE_ARGUMENTS_ABOVE = 4 * 1024 * 1024;

/** Above this many bytes, a staged object goes over the resumable protocol in
 *  chunks of exactly this size, which is the chunk size Storage's resumable
 *  endpoint requires of every chunk but the last. */
export const RESUMABLE_ABOVE = 6 * 1024 * 1024;

/** A decision that can be refused as a usage error, with the sentence why. */
export type Judged<T> = { ok: true; value: T } | { ok: false; message: string };

const yes = <T>(value: T): Judged<T> => ({ ok: true, value });
const no = <T>(message: string): Judged<T> => ({ ok: false, message });

/**
 * The exit code an HTTP answer earns.
 *
 * A 401 is the key and a 429 the key's rate, each with its own code so a script
 * can tell "fix the key" and "wait" from "the operation said no". A 5xx is the
 * server failing rather than refusing, so it is grouped with an answer that never
 * arrived.
 */
export function exitForStatus(status: number): number {
  if (status >= 200 && status < 300) return EXIT.ok;
  if (status === 401) return EXIT.auth;
  if (status === 429) return EXIT.limited;
  if (status >= 400 && status < 500) return EXIT.refused;
  return EXIT.transport;
}

/** One `--name value` as typed: a value, or `true` for a flag given bare. */
export interface TypedFlag {
  name: string;
  value: string | true;
}

/** What a `call` invocation asks for, before the catalogue is read. */
export type CallRequest =
  | { kind: "list" }
  | {
      kind: "call";
      operation: string;
      flags: TypedFlag[];
      json: string | null;
      /** `--stage-in`: the workspace large arguments are staged in, by name or
       *  id. It is this program's, and never sent as an argument. */
      stageIn: string | null;
    };

/**
 * Whether a word on `call`'s command line is a `--flag`.
 *
 * Three or more dashes are not a flag but a value: `---` opens a document's
 * front matter and `----` is a markdown rule, and either is far likelier to be
 * text than an argument whose name starts with a dash.
 */
function isFlag(word: string): boolean {
  return word.startsWith("--") && word !== "--" && !word.startsWith("---");
}

/**
 * Reads the words after `call`.
 *
 * Its own parser rather than the registry's, because an operation's flags are
 * not known until the catalogue is read: every `--name` takes the word after it
 * as its value unless that word is itself a `--flag`, so `-` (standard input), a
 * negative number and `---` are values. `--name=value` carries a value that
 * starts with `--`. A flag with nothing after it is `true`, which only a boolean
 * argument accepts.
 */
export function parseCall(argv: readonly string[]): Judged<CallRequest> {
  const flags: TypedFlag[] = [];
  const positional: string[] = [];
  let json: string | null = null;
  let stageIn: string | null = null;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (!isFlag(word)) {
      positional.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const name = word.slice(2, eq < 0 ? undefined : eq);
    let value: string | true;
    if (eq >= 0) value = word.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !isFlag(argv[i + 1])) value = argv[++i];
    else value = true;
    if (name === "list") {
      list = true;
      continue;
    }
    if (name === "json") {
      if (value === true) return no("--json needs a file, or - for standard input.");
      json = value;
      continue;
    }
    if (name === "stage-in") {
      if (value === true) return no("--stage-in needs a workspace, by name or id.");
      stageIn = value;
      continue;
    }
    flags.push({ name, value });
  }
  if (list) return yes({ kind: "list" });
  if (positional.length === 0) return no("Name an operation: mdbrain call <operation> [--<argument> <value>]... (mdbrain call --list shows them).");
  if (positional.length > 1) {
    return no(`Only one operation per call; also given: ${positional.slice(1).join(" ")}. Arguments are written --name value.`);
  }
  return yes({ kind: "call", operation: positional[0], flags, json, stageIn });
}

/** Where a typed value comes from: the text itself, or a file it names. */
export type ValueSource = { kind: "literal"; text: string } | { kind: "file"; path: string };

/**
 * Whether a typed value names a file.
 *
 * `@path` reads the file, so a large document does not have to travel through
 * the shell. A value that genuinely starts with `@` — a mention, say — is
 * written `@@`, which is read as the text with one `@` taken off. There is no
 * guessing from whether the file exists: a mention that happened to match a file
 * name would otherwise send that file's contents.
 */
export function valueSource(text: string): ValueSource {
  if (text.startsWith("@@")) return { kind: "literal", text: text.slice(1) };
  if (text.startsWith("@") && text.length > 1) return { kind: "file", path: text.slice(1) };
  return { kind: "literal", text };
}

/** The JSON types a schema admits, read through `anyOf`, `oneOf` and `enum`. */
export function typesOf(schema: JsonSchema | undefined): Set<string> {
  const types = new Set<string>();
  if (!schema) return types;
  if (typeof schema.type === "string") types.add(schema.type);
  else if (Array.isArray(schema.type)) for (const t of schema.type) types.add(t);
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) for (const t of typesOf(branch)) types.add(t);
  for (const value of schema.enum ?? []) types.add(value === null ? "null" : typeof value);
  return types;
}

/** How an argument's types read in a message: `number`, `string or null`. */
function describeTypes(types: Set<string>): string {
  return [...types].join(" or ") || "any value";
}

/**
 * The argument name a typed flag means: the name itself, or its kebab-case
 * spelling of a snake_case argument (`--workspace-id` for `workspace_id`).
 */
export function argumentName(typed: string, known: readonly string[]): string | null {
  if (known.includes(typed)) return typed;
  const snake = typed.replace(/-/g, "_");
  return known.includes(snake) ? snake : null;
}

/**
 * A typed value as the type its argument declares.
 *
 * A command line carries only text, so the schema decides: text stays text
 * wherever a string is accepted, a number must read as a finite number (and a
 * whole one for an integer), a boolean is `true` or `false` or the flag given
 * bare, and an array or object must be JSON of that shape. A refusal names the
 * argument and the type it wanted, which is what the person has to fix.
 */
export function coerceValue(name: string, raw: string | true, schema: JsonSchema | undefined): Judged<unknown> {
  const types = typesOf(schema);
  const wanted = describeTypes(types);
  if (raw === true) {
    if (types.size === 0 || types.has("boolean")) return yes(true);
    // The likeliest way to get here with a value in mind is a value that starts
    // with `--`, which the parser cannot tell from the next flag.
    return no(`--${name} needs a value (${wanted}); a value that starts with -- is written --${name}=value.`);
  }
  if (raw === "null" && types.has("null") && !types.has("string")) return yes(null);
  if (types.size === 0) {
    try {
      return yes(JSON.parse(raw));
    } catch {
      return yes(raw);
    }
  }
  if (types.has("string")) return yes(raw);
  if (types.has("number") || types.has("integer")) {
    const n = raw.trim() === "" ? Number.NaN : Number(raw);
    if (Number.isFinite(n) && (types.has("number") || Number.isInteger(n))) return yes(n);
  }
  if (types.has("boolean") && (raw === "true" || raw === "false")) return yes(raw === "true");
  if (types.has("array") || types.has("object")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (types.has("array") && Array.isArray(parsed)) return yes(parsed);
    if (types.has("object") && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return yes(parsed);
    return no(`--${name} expects ${wanted} written as JSON; got ${JSON.stringify(raw)}.`);
  }
  return no(`--${name} expects ${wanted}; got ${JSON.stringify(raw)}.`);
}

/**
 * The argument object a call sends: the `--json` object first, then each flag
 * over it, so a flag given alongside a file overrides that key.
 *
 * @param entry the operation, for its argument schema
 * @param base what `--json` supplied, or an empty object
 * @param flags the typed flags, each value already read from its file if it
 *   named one
 * @returns the arguments, or the usage error naming what was wrong
 */
export function buildArguments(
  entry: CatalogueEntry,
  base: Record<string, unknown>,
  flags: readonly TypedFlag[],
): Judged<Record<string, unknown>> {
  const properties = entry.input_schema?.properties ?? {};
  const known = Object.keys(properties);
  const args: Record<string, unknown> = { ...base };
  for (const flag of flags) {
    const name = argumentName(flag.name, known);
    if (name === null) {
      const list = known.length > 0 ? `it takes ${known.map((k) => `--${k}`).join(", ")}` : "it takes no arguments";
      return no(`${entry.name} has no argument --${flag.name}; ${list}.`);
    }
    const value = coerceValue(name, flag.value, properties[name]);
    if (!value.ok) return value;
    args[name] = value.value;
  }
  return yes(args);
}

/** The parts of an HTTP request a call is sent as, relative to the API's base. */
export interface PlannedRequest {
  method: string;
  /** The route under `/v1`, its `{name}` segments filled in. */
  route: string;
  /** Whether the arguments travel in the query string rather than a body. */
  inQuery: boolean;
  /** The query string, with its `?`, or empty. */
  query: string;
  /** The arguments the route does not carry: the body, or what is staged. */
  payload: Record<string, unknown>;
}

/** A query-string value: text as it is, JSON for anything that is not. */
function queryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * How one call goes over the wire.
 *
 * A `{name}` segment in the route binds that argument; on `GET` and `DELETE` the
 * rest go in the query string, otherwise in a JSON body. That mirrors how the
 * server reads them, so an argument list typed here means the same thing there.
 *
 * @returns the request, or a usage error when an argument the route needs is
 *   missing
 */
export function planRequest(entry: CatalogueEntry, args: Record<string, unknown>): Judged<PlannedRequest> {
  const rest: Record<string, unknown> = { ...args };
  let missing: string | null = null;
  const path = entry.path.replace(/^\/v1/, "").replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
    const value = rest[name];
    delete rest[name];
    if (value === undefined || value === null || value === "") {
      missing ??= name;
      return "";
    }
    return encodeURIComponent(queryValue(value));
  });
  if (missing !== null) return no(`${entry.name} needs --${missing}.`);
  const method = entry.method.toUpperCase();
  if (method === "GET" || method === "DELETE") {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(rest)) {
      if (value === undefined || value === null) continue;
      query.append(name, queryValue(value));
    }
    const qs = query.toString();
    return yes({ method, route: path, inQuery: true, query: qs ? `?${qs}` : "", payload: rest });
  }
  return yes({ method, route: path, inQuery: false, query: "", payload: rest });
}

/**
 * Whether a call's arguments are too large to send as a body and must be staged.
 *
 * The decision is on the serialised arguments' size in bytes, not characters,
 * because the limit it avoids is the server's byte limit. Query-string arguments
 * are measured too: a `GET` whose arguments run to megabytes is staged the same
 * way, since the server reads a named upload on any route.
 */
export function shouldStage(serialisedBytes: number): boolean {
  return serialisedBytes > STAGE_ARGUMENTS_ABOVE;
}

/** A workspace as `GET /v1/workspaces` lists it. */
export interface WorkspaceRow {
  id: string;
  name: string;
}

/**
 * Which workspace a typed `<workspace>` means: an id outright, or an exact name.
 *
 * A name two workspaces share is refused with both ids rather than resolved to
 * either, because reading from or uploading into the wrong brain is not an
 * error anything later would catch.
 */
export function resolveWorkspace(rows: readonly WorkspaceRow[], typed: string): Judged<WorkspaceRow> {
  const byId = rows.find((w) => w.id === typed);
  if (byId) return yes(byId);
  const named = rows.filter((w) => w.name === typed);
  if (named.length === 1) return yes(named[0]);
  if (named.length > 1) {
    return no(`${named.length} workspaces are named "${typed}"; give one by its id: ${named.map((w) => w.id).join(", ")}.`);
  }
  const names = rows.map((w) => `"${w.name}"`).join(", ");
  return no(`No workspace is named "${typed}"${names ? `; you can reach ${names}` : "; you can reach none"}.`);
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/**
 * The MIME type the first of `fileNames` with a known image extension names.
 *
 * `upload` passes the local file first, because its extension describes the
 * bytes actually sent, then the name it is given, for a local file with no
 * extension. A name with no dot has no extension: `png` alone is a name, not a
 * type. None known is sent as bytes and left to the server to accept or refuse.
 */
export function mimeFor(...fileNames: string[]): string {
  for (const fileName of fileNames) {
    const base = fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1);
    const dot = base.lastIndexOf(".");
    if (dot < 0) continue;
    const type = IMAGE_TYPES[base.slice(dot + 1).toLowerCase()];
    if (type) return type;
  }
  return "application/octet-stream";
}

/** A workspace id as the API issues them: a UUID. */
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a typed `<workspace>` is already an id, which needs no lookup: a
 *  wrong one is refused by the call that uses it, as any other bad id is. */
export function isWorkspaceId(typed: string): boolean {
  return WORKSPACE_ID.test(typed);
}

/** `--list`'s lines: each operation's name, method and route, with the ones a
 *  person's key cannot run marked. */
export function renderList(entries: readonly CatalogueEntry[]): string[] {
  const width = Math.max(0, ...entries.map((e) => e.name.length));
  const methodWidth = Math.max(0, ...entries.map((e) => e.method.length));
  return entries.map((e) => {
    const agentOnly = e.actors !== undefined && e.actors.length > 0 && !e.actors.includes("person");
    return `${e.name.padEnd(width)}  ${e.method.padEnd(methodWidth)}  ${e.path}${agentOnly ? "  [agent only]" : ""}`.trimEnd();
  });
}

/**
 * The sentence a refusal is reported with on stderr: the server's code and
 * message when it sent the API's error shape, the status otherwise.
 */
export function refusalLine(status: number, body: unknown): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string" ? error.message : null;
  if (code && message) return `${code}: ${message}`;
  if (code) return `${code} (HTTP ${status})`;
  return `HTTP ${status}`;
}

/** What to tell a person with neither a key nor a login to use. Names both,
 *  because either is enough and which one suits depends on where it runs. */
export const NO_CREDENTIAL = "No credential: set MDBRAIN_API_KEY to a member key, or run `mdbrain login`.";

/** What to tell a person whose key was refused, with no login to fall back on.
 *  Says nothing about which reason, because the server answers every unusable
 *  key identically. */
export const KEY_REFUSED =
  "The key in MDBRAIN_API_KEY was not accepted: it is malformed, unknown or revoked, or its member has left the organization.";

/** Said once on stderr when a refused key gives way to the login, so a revoked
 *  CI key does not go unnoticed behind a login that happens to work. */
export const KEY_GAVE_WAY = "The key in MDBRAIN_API_KEY was not accepted; using your mdbrain login instead.";

/** What to tell a person whose login the API refused. The remedy is a fresh
 *  login, never a key, because no key was presented. */
export const LOGIN_REFUSED = "Your mdbrain login was not accepted. Run `mdbrain login` again.";

/** What to tell a person with no key whose API address is not this product's,
 *  where the login is never sent. */
export const LOGIN_NOT_SENT_THERE =
  "MDBRAIN_API_URL points somewhere other than markdownbrain.ai, so your login is not sent there. Set MDBRAIN_API_KEY to use a key with it.";
