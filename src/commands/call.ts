// `mdbrain call`, `mdbrain read` and `mdbrain upload` — the HTTP API from a
// shell.
//
// These three are the only commands that speak to the API rather than to the
// app or the MCP server. Each authenticates with the member key in
// `MDBRAIN_API_KEY` when it is set, and otherwise with the login `mdbrain login`
// keeps; nothing here mints a key. They share one contract with whatever script
// runs them:
// **stdout carries the answer's body and nothing else** — the body of a refusal
// too, so a script that parses stdout always has something to parse — every
// sentence for a person goes to stderr, and the exit code says which kind of
// outcome it was (`EXIT` in `api/call.ts`). The credential itself is never
// printed, and a message that could echo it is redacted on its way to the
// terminal.

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { CommandContext, CommandSpec } from "../cli.ts";
import {
  ARGUMENTS_UPLOAD_HEADER,
  EXIT,
  KEY_GAVE_WAY,
  KEY_REFUSED,
  LOGIN_NOT_SENT_THERE,
  LOGIN_REFUSED,
  NO_CREDENTIAL,
  ROUTES,
  buildArguments,
  exitForStatus,
  isWorkspaceId,
  mimeFor,
  parseCall,
  planRequest,
  refusalLine,
  renderList,
  resolveWorkspace,
  shouldStage,
  valueSource,
  type CatalogueEntry,
  type TypedFlag,
  type WorkspaceRow,
} from "../api/call.ts";
import {
  LocalFileError,
  StorageError,
  TransportError,
  bytesSource,
  callApi,
  fileSource,
  sendStaged,
  type ApiAnswer,
  type BegunUpload,
  type ByteSource,
} from "../api/http.ts";
import { apiBase, loginMayGoTo } from "../auth/project.ts";
import { redactSecrets } from "../run/diagnosis.ts";
import { readySession, type SessionOutcome } from "./session.ts";

/** What the three commands take from the world beyond the network and the
 *  disk: the environment, standard input, and the stored login. Stood in by
 *  tests. */
export interface ApiCommandDeps {
  env: Record<string, string | undefined>;
  readStdin(): Promise<string>;
  /** The login's access token, refreshed if it must be, or why there is none.
   *  Asked only when the key is unset or refused, so a key that works never
   *  reads the session file. */
  session(): Promise<SessionOutcome>;
}

const defaultDeps = (): ApiCommandDeps => ({
  env: process.env,
  session: () => readySession(),
  async readStdin() {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  },
});

/** A failure that already knows its exit code, its sentence, and the body
 *  stdout carries for it, if any. Thrown inside a command, caught once. */
class Stop extends Error {
  readonly code: number;
  readonly stdout: string | null;
  // Fields assigned by hand rather than as parameter properties, which Node's
  // type stripping cannot run, and `node src/main.ts` is a supported start.
  constructor(code: number, message: string, stdout: string | null = null) {
    super(message);
    this.code = code;
    this.stdout = stdout;
  }
}

/** The body stdout carries when the server sent nothing parseable, in the API's
 *  own error shape, so a script never parses an empty stdout or a gateway page. */
function errorBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } }, null, 2);
}

/** An answer's body as stdout carries it: JSON indented, anything else as it came. */
function bodyText(answer: ApiAnswer): string {
  return answer.isJson ? JSON.stringify(answer.body, null, 2) : answer.text;
}

/** Which credential an invocation is sending: the key, or the login. */
type CredentialKind = "key" | "session";

/**
 * Turns a refused answer into the `Stop` it ends the command with: the body on
 * stdout, the reason on stderr, and the exit code its status earns. A 401 is
 * said in this program's words, naming whichever credential was refused, since
 * the server's body for it names nothing; a 429 says when to try again.
 *
 * The body is redacted as the sentence is: a refusal is the answer most likely
 * to come from a gateway or proxy rather than the API, and one that echoes the
 * request echoes its `Authorization` header — into a log a script keeps.
 */
function refused(answer: ApiAnswer, kind: CredentialKind): Stop {
  const unauthenticated = kind === "key" ? KEY_REFUSED : LOGIN_REFUSED;
  const lines = [answer.status === 401 ? unauthenticated : refusalLine(answer.status, answer.body)];
  if (answer.status === 429) lines.push(`Retry-After: ${answer.retryAfter ?? "not given"}`);
  const stdout = answer.isJson ? bodyText(answer) : errorBody(`http_${answer.status}`, answer.text.trim().slice(0, 300));
  return new Stop(exitForStatus(answer.status), lines.join("\n"), redactSecrets(stdout));
}

/** A local input — a named file, standard input — that could not be read: a
 *  usage error, with an error body so stdout still parses. */
function localFailure(message: string): Stop {
  return new Stop(EXIT.usage, message, errorBody("local_file", redactSecrets(message)));
}

/**
 * One invocation's line to the API: its address, and the one credential every
 * request in the invocation carries.
 *
 * **The credential is settled by the first answer and never changes after it.**
 * A key the API refuses with a 401 on that first request gives way to the login,
 * and the same request is sent again with it: a 401 means no operation ran, so
 * asking again cannot double a write. Any other answer settles the key — a 429
 * or a 5xx says the key worked, and switching would only spread the load over
 * two buckets. Settling once is what keeps a catalogue read, a staged upload and
 * the call it commits from ever carrying two different credentials.
 */
class Line {
  readonly base: string;
  private kind: CredentialKind;
  private token: string;
  private settled = false;
  private readonly deps: ApiCommandDeps;
  private readonly context: CommandContext;

  // Fields assigned by hand, as `Stop`'s are, for Node's type stripping.
  constructor(base: string, kind: CredentialKind, token: string, deps: ApiCommandDeps, context: CommandContext) {
    this.base = base;
    this.kind = kind;
    this.token = token;
    this.deps = deps;
    this.context = context;
  }

  /** Sends one request with this invocation's credential, giving a refused key
   *  way to the login on the first answer only. */
  async send(method: string, path: string, options?: { json?: string; headers?: Record<string, string> }): Promise<ApiAnswer> {
    // A login's token is asked for again before every request after the first,
    // because an upload can outlast its hour: begun with a minute left, its
    // commit would go out expired after every byte had been sent. The session
    // file is read each time and refreshed only when it is due, and a renewal
    // that fails leaves the token in hand to be tried.
    if (this.kind === "session" && this.settled) {
      const fresh = await this.deps.session();
      if (fresh.kind === "ready") this.token = fresh.accessToken;
    }
    const answer = await callApi(this.base, this.token, method, path, options);
    if (this.settled) return answer;
    this.settled = true;
    if (answer.status !== 401 || this.kind !== "key" || !loginMayGoTo(this.base)) return answer;
    const session = await this.deps.session();
    if (session.kind !== "ready") return answer;
    this.context.err(KEY_GAVE_WAY);
    this.kind = "session";
    this.token = session.accessToken;
    return callApi(this.base, this.token, method, path, options);
  }

  /** An answer the command can only go on from if it succeeded; a refusal ends it. */
  accepted(answer: ApiAnswer): ApiAnswer {
    if (exitForStatus(answer.status) !== EXIT.ok) throw refused(answer, this.kind);
    return answer;
  }

  /** A request that must succeed for the command to go on. */
  async must(method: string, path: string, options?: { json?: string; headers?: Record<string, string> }): Promise<ApiAnswer> {
    return this.accepted(await this.send(method, path, options));
  }
}

/**
 * The line an invocation speaks on, or the stop for having no credential —
 * decided before anything is sent.
 *
 * The key comes first whenever it is set, exactly as it always has, so CI and
 * scripts that set it see no change. Without one, the login is used, but only at
 * an address `loginMayGoTo` allows. A login that has to be renewed and cannot be
 * is said with the session's own sentences, so it reads the same here as in every
 * other command; one the auth server could not be reached to renew is a transport
 * failure rather than a credential one, because nothing has said it is over.
 */
async function lineFor(deps: ApiCommandDeps, context: CommandContext): Promise<Line> {
  const base = baseFrom(deps.env);
  const key = deps.env.MDBRAIN_API_KEY?.trim();
  if (key) return new Line(base, "key", key, deps, context);
  if (!loginMayGoTo(base)) throw new Stop(EXIT.auth, LOGIN_NOT_SENT_THERE);
  const session = await deps.session();
  if (session.kind === "ready") return new Line(base, "session", session.accessToken, deps, context);
  if (session.reason === "sign-in") throw new Stop(EXIT.auth, NO_CREDENTIAL);
  throw new Stop(session.reason === "unreachable" ? EXIT.transport : EXIT.auth, session.message);
}

/** The API's address, or the stop for one that cannot be used — taken before
 *  anything is sent, since the first request already carries the credential. */
function baseFrom(env: Record<string, string | undefined>): string {
  const base = apiBase(env);
  if (!base.ok) throw new Stop(EXIT.usage, base.message);
  return base.value;
}

/**
 * The body of an answer the command reads rather than prints, or a transport
 * failure when it is not what the API sends.
 *
 * A 2xx of the wrong shape is almost never the API: it is a captive portal, a
 * proxy or a gateway answering in its place. Read as though it were the API, it
 * would print an empty list and exit 0, call a known operation unknown, or send
 * bytes to an address that is not one — so it is reported as the answer never
 * having arrived, which is what happened.
 *
 * @param answer the accepted answer
 * @param what what it should have been, for the message
 * @param fits whether its parsed body is that
 */
function shaped<T>(answer: ApiAnswer, what: string, fits: (body: unknown) => body is T): T {
  if (answer.isJson && fits(answer.body)) return answer.body;
  const came = answer.isJson ? "JSON of another shape" : "something that is not JSON";
  throw new TransportError(
    `Expected ${what} but got HTTP ${answer.status} with ${came}; something between here and the API, such as a portal or a proxy, may have answered instead.`,
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isCatalogue = (v: unknown): v is { operations: CatalogueEntry[] } =>
  isRecord(v) &&
  Array.isArray(v.operations) &&
  v.operations.every((e) => isRecord(e) && typeof e.name === "string" && typeof e.method === "string" && typeof e.path === "string");

const isWorkspaceList = (v: unknown): v is WorkspaceRow[] =>
  Array.isArray(v) && v.every((r) => isRecord(r) && typeof r.id === "string" && typeof r.name === "string");

const isBegunUpload = (v: unknown): v is BegunUpload =>
  isRecord(v) &&
  typeof v.upload_id === "string" &&
  typeof v.url === "string" &&
  (v.resumable === undefined ||
    (isRecord(v.resumable) &&
      typeof v.resumable.endpoint === "string" &&
      isRecord(v.resumable.headers) &&
      typeof v.resumable.bucket === "string" &&
      typeof v.resumable.object_name === "string"));

/** A file read names the kind of file it read, a document or an image, which
 *  is what tells a read with no text apart from an answer that is not one. */
const isFileRead = (v: unknown): v is { kind: string; content?: unknown } => isRecord(v) && typeof v.kind === "string";

/**
 * Runs one command body and reports how it ended.
 *
 * Every failure path goes through here, so the rules hold in one place: a
 * transport failure, a Storage refusal and a local file that failed also put an
 * error body on stdout, and every sentence is redacted before it reaches the
 * terminal, because a gateway or a proxy that echoes a request echoes its
 * credential with it.
 *
 * A local file that fails mid-upload is a usage error (`2`), like one that
 * cannot be read at the start: the input the invocation named could not be
 * used, which is neither the server refusing nor the network failing. Anything
 * else that escapes is a fault of this program's; it still leaves an error body
 * on stdout, coded `internal`, and exits `1`, the code an uncaught failure
 * would have exited with anyway.
 */
async function reported(context: CommandContext, body: () => Promise<void>): Promise<number> {
  const fail = (code: number, kind: string, said: string): number => {
    const message = redactSecrets(said);
    context.out(errorBody(kind, message));
    context.err(message);
    return code;
  };
  try {
    await body();
    return EXIT.ok;
  } catch (cause) {
    if (cause instanceof Stop) {
      if (cause.stdout !== null) context.out(cause.stdout);
      context.err(redactSecrets(cause.message));
      return cause.code;
    }
    if (cause instanceof StorageError) return fail(cause.status >= 500 ? EXIT.transport : EXIT.refused, "storage", cause.message);
    if (cause instanceof TransportError) return fail(EXIT.transport, "transport", cause.message);
    if (cause instanceof LocalFileError) return fail(EXIT.usage, "local_file", cause.message);
    return fail(EXIT.refused, "internal", cause instanceof Error ? cause.message : String(cause));
  }
}

/** Reads a local file named on the command line, or stops with a usage error. */
async function readLocal(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (cause) {
    throw localFailure(`Could not read ${what} ${path}: ${(cause as NodeJS.ErrnoException).code ?? (cause as Error).message}`);
  }
}

/** Reads standard input for `--json -`, or stops with a usage error. */
async function readStdin(deps: ApiCommandDeps): Promise<string> {
  try {
    return await deps.readStdin();
  } catch (cause) {
    throw localFailure(`Could not read standard input: ${(cause as NodeJS.ErrnoException).code ?? (cause as Error).message}`);
  }
}

/**
 * Stages bytes: asks for an upload, then sends them to Storage.
 *
 * @returns the upload's id, for the call that commits it
 */
async function stage(line: Line, workspaceId: string, purpose: "image" | "arguments", source: ByteSource, contentType: string): Promise<string> {
  const begun = await line.must("POST", ROUTES.beginUpload, {
    json: JSON.stringify({ workspace_id: workspaceId, purpose, size: source.size, content_type: contentType }),
  });
  const upload = shaped(begun, "an upload to send to", isBegunUpload);
  await sendStaged(upload, source, contentType);
  return upload.upload_id;
}

/**
 * The workspace a typed name or id means. An id is taken as it is, without
 * listing the credential's workspaces, which spares a request against its rate;
 * a name is looked up.
 */
async function workspaceNamed(line: Line, typed: string): Promise<WorkspaceRow> {
  if (isWorkspaceId(typed)) return { id: typed, name: typed };
  const answer = await line.must("GET", ROUTES.workspaces);
  const rows = shaped(answer, "the workspaces you can reach", isWorkspaceList);
  const chosen = resolveWorkspace(rows, typed);
  if (!chosen.ok) throw new Stop(EXIT.usage, chosen.message);
  return chosen.value;
}

/**
 * `call`'s body: the catalogue, the arguments, the request, and the answer.
 *
 * The catalogue is read once per invocation, so this program carries no copy
 * of the operation list and an operation the server gains works here without a
 * new build.
 */
export async function runCall(deps: ApiCommandDeps, context: CommandContext): Promise<number> {
  return reported(context, async () => {
    const asked = parseCall(context.argv ?? []);
    if (!asked.ok) throw new Stop(EXIT.usage, asked.message);
    const line = await lineFor(deps, context);

    const listing = await line.must("GET", ROUTES.operations);
    const entries = shaped(listing, "the list of operations", isCatalogue).operations;
    if (asked.value.kind === "list") {
      for (const line of renderList(entries)) context.out(line);
      return;
    }
    const { operation, json } = asked.value;
    const entry = entries.find((e) => e.name === operation);
    if (!entry) throw new Stop(EXIT.usage, `Unknown operation "${operation}". mdbrain call --list names them.`);

    let fromJson: Record<string, unknown> = {};
    if (json !== null) {
      const text = json === "-" ? await readStdin(deps) : (await readLocal(json, "the --json file")).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Stop(EXIT.usage, `--json ${json} is not valid JSON.`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Stop(EXIT.usage, `--json ${json} must hold one JSON object of arguments.`);
      }
      fromJson = parsed as Record<string, unknown>;
    }

    // A value written `@file` is read here, before coercion, so the file's text
    // is judged against the argument's type exactly as a typed value would be.
    const flags: TypedFlag[] = [];
    for (const flag of asked.value.flags) {
      if (flag.value === true) {
        flags.push(flag);
        continue;
      }
      const source = valueSource(flag.value);
      const value = source.kind === "file" ? (await readLocal(source.path, `--${flag.name}'s file`)).toString("utf8") : source.text;
      flags.push({ name: flag.name, value });
    }

    const args = buildArguments(entry, fromJson, flags);
    if (!args.ok) throw new Stop(EXIT.usage, args.message);
    const plan = planRequest(entry, args.value);
    if (!plan.ok) throw new Stop(EXIT.usage, plan.message);
    const { method, route, query, inQuery, payload } = plan.value;

    // Serialised and encoded once: the same bytes are measured, and staged when
    // they are too many, so a document of megabytes is not copied over again.
    const serialised = JSON.stringify(payload);
    const bytes = Buffer.from(serialised, "utf8");
    let answer: ApiAnswer;
    if (shouldStage(bytes.byteLength)) {
      // An upload is staged in a workspace, because that is where the database
      // decides who may stage at all. Any workspace the key may edit will do,
      // since the staged object is read back by its id alone: `--stage-in`
      // names one, and without it the operation's own `workspace_id` does —
      // arguments too large for a body are, in practice, a document's content,
      // and name the workspace it goes to.
      const own = payload.workspace_id;
      const stageIn = asked.value.stageIn;
      let workspaceId: string;
      if (stageIn !== null) workspaceId = (await workspaceNamed(line, stageIn)).id;
      else if (typeof own === "string" && own !== "") workspaceId = own;
      else {
        throw new Stop(
          EXIT.usage,
          `These arguments are over 4 MB and must be staged in a workspace, and ${operation} names none; add --stage-in <workspace>, any workspace you may edit.`,
        );
      }
      const uploadId = await stage(line, workspaceId, "arguments", bytesSource(bytes), "application/json");
      answer = await line.send(method, route, { headers: { [ARGUMENTS_UPLOAD_HEADER]: uploadId } });
    } else if (inQuery) {
      answer = await line.send(method, `${route}${query}`);
    } else {
      answer = await line.send(method, route, { json: serialised });
    }
    context.out(bodyText(line.accepted(answer)));
  });
}

/** `read`'s body: the workspace by name or id, then the document, printed raw. */
export async function runRead(deps: ApiCommandDeps, context: CommandContext): Promise<number> {
  return reported(context, async () => {
    const [typed, path, ...extra] = context.positional;
    if (typed === undefined || path === undefined || extra.length > 0) {
      throw new Stop(EXIT.usage, "Usage: mdbrain read <workspace> <path>");
    }
    const line = await lineFor(deps, context);
    const workspace = await workspaceNamed(line, typed);
    const query = new URLSearchParams({ path, workspace_id: workspace.id });
    const answer = await line.must("GET", `${ROUTES.readFile}?${query.toString()}`);
    const content = shaped(answer, "the document", isFileRead).content;
    // Exit 1 with an error body, as a refusal would: the request was well
    // formed and answered, but what it names cannot be printed as text, which
    // is the operation saying no to this use of it rather than a usage error.
    if (typeof content !== "string") {
      const message = `${path} has no text to print (it is an image, or not a document); mdbrain call read_file --path ${path} shows what it is.`;
      throw new Stop(EXIT.refused, message, errorBody("not_text", message));
    }
    // Raw and unterminated: `mdbrain read brain TODO.md > TODO.md` must write
    // the document's bytes, not the document and a newline this program added.
    (context.write ?? context.out)(content);
  });
}

/** `upload`'s body: the file's size, the workspace, the staging, the commit. */
export async function runUpload(deps: ApiCommandDeps, context: CommandContext): Promise<number> {
  return reported(context, async () => {
    const [typed, local, ...extra] = context.positional;
    if (typed === undefined || local === undefined || extra.length > 0) {
      throw new Stop(EXIT.usage, "Usage: mdbrain upload <workspace> <local-file> [--to <folder>] [--name <name>]");
    }
    const to = context.flags.to;
    const named = context.flags.name;
    if (to === true || named === true) throw new Stop(EXIT.usage, `--${to === true ? "to" : "name"} needs a value.`);
    let info;
    try {
      info = await stat(local);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      throw localFailure(code === "ENOENT" ? `Could not read ${local}: no such file.` : `Could not read ${local}: ${code ?? (cause as Error).message}`);
    }
    if (!info.isFile()) throw localFailure(`Could not upload ${local}: it is not a file.`);
    const line = await lineFor(deps, context);
    const workspace = await workspaceNamed(line, typed);
    const name = typeof named === "string" ? named : basename(local);
    const contentType = mimeFor(local, name);
    const uploadId = await stage(line, workspace.id, "image", fileSource(local, info), contentType);
    const committed = await line.must("POST", ROUTES.uploadImage, {
      json: JSON.stringify({
        workspace_id: workspace.id,
        name,
        upload_id: uploadId,
        content_type: contentType,
        ...(typeof to === "string" ? { parent_path: to } : {}),
      }),
    });
    context.out(bodyText(committed));
  });
}

export const call: CommandSpec = {
  name: "call",
  usage: "<operation> [--arg value]...",
  summary: "run one operation on the HTTP API and print its JSON answer (MDBRAIN_API_KEY, else your login)",
  flags: [
    { name: "json", summary: "read the arguments from a JSON file, or - for stdin; flags override its keys", takesValue: true },
    { name: "list", summary: "list every operation with its method and route" },
    { name: "stage-in", summary: "the workspace to stage arguments over 4 MB in, when the operation names none", takesValue: true },
  ],
  ownsArgv: true,
  run: (context) => runCall(defaultDeps(), context),
};

export const read: CommandSpec = {
  name: "read",
  usage: "<workspace> <path>",
  summary: "print a document's content as it is, for redirecting into a file (MDBRAIN_API_KEY, else your login)",
  run: (context) => runRead(defaultDeps(), context),
};

export const upload: CommandSpec = {
  name: "upload",
  usage: "<workspace> <local-file>",
  summary: "upload an image of any size into a workspace, and print what was created (MDBRAIN_API_KEY, else your login)",
  flags: [
    { name: "to", summary: "the folder to put it in; the workspace root when omitted", takesValue: true },
    { name: "name", summary: "the name to give it; the local file's name when omitted", takesValue: true },
  ],
  run: (context) => runUpload(defaultDeps(), context),
};
