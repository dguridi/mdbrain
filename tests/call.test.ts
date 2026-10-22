import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { CommandContext } from "../src/cli.ts";
import { dispatch } from "../src/cli.ts";
import { COMMANDS, VERSION } from "../src/main.ts";
import { runCall, runRead, runUpload, type ApiCommandDeps } from "../src/commands/call.ts";
import {
  EXIT,
  RESUMABLE_ABOVE,
  STAGE_ARGUMENTS_ABOVE,
  coerceValue,
  exitForStatus,
  isWorkspaceId,
  mimeFor,
  parseCall,
  planRequest,
  renderList,
  resolveWorkspace,
  shouldStage,
  valueSource,
  type CatalogueEntry,
} from "../src/api/call.ts";
import { TIMEOUTS, uploadOffset } from "../src/api/http.ts";
import { apiBase, API_URL, loginMayGoTo } from "../src/auth/project.ts";
import type { SessionOutcome } from "../src/commands/session.ts";

const KEY = "mdb_key_0123abcd_" + "k".repeat(43);
/** A login's access token, shaped as one so the redaction that knows JWTs is exercised. */
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${"p".repeat(40)}.${"s".repeat(43)}`;
const NO_LOGIN: SessionOutcome = { kind: "stop", reason: "sign-in", message: "You are not signed in. Run `mdbrain login`." };

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

type Handler = (req: Seen, res: ServerResponse) => void;

const CATALOGUE: CatalogueEntry[] = [
  {
    name: "read_file",
    method: "GET",
    path: "/v1/file",
    actors: ["agent", "person"],
    input_schema: { type: "object", properties: { file_id: { type: "string" }, path: { type: "string" }, workspace_id: { type: "string" } } },
  },
  {
    name: "list_notifications",
    method: "GET",
    path: "/v1/notifications",
    actors: ["agent", "person"],
    input_schema: { type: "object", properties: { limit: { type: "number" }, unread_only: { type: "boolean" } } },
  },
  {
    name: "create_file",
    method: "POST",
    path: "/v1/files",
    actors: ["agent", "person"],
    input_schema: {
      type: "object",
      properties: { workspace_id: { type: "string" }, path: { type: "string" }, content: { type: "string" } },
      required: ["workspace_id"],
    },
  },
  {
    name: "rename_node",
    method: "POST",
    path: "/v1/nodes/rename",
    actors: ["agent", "person"],
    input_schema: { type: "object", properties: { path: { type: "string" }, new_name: { type: "string" } } },
  },
  {
    name: "read_thread",
    method: "GET",
    path: "/v1/threads/{thread_id}",
    actors: ["agent", "person"],
    input_schema: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] },
  },
  {
    name: "notify_person",
    method: "POST",
    path: "/v1/notify",
    actors: ["agent"],
    input_schema: { type: "object", properties: { to: { type: "string" }, message: { type: "string" } } },
  },
];

let server: Server;
let base: string;
let origin: string;
let seen: Seen[] = [];
let handlers: Record<string, Handler> = {};
/** What Storage holds, by object name, as the fake receives it. */
let stored: Map<string, Buffer>;
let tus: Map<string, { object: string; length: number; chunks: Buffer[] }>;
let failNextPatch = false;
let uploadCount = 0;

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
};

/** Routes the fake answers on its own; a test overrides any by "METHOD /path". */
const builtIn = (req: Seen, res: ServerResponse): void => {
  const path = req.url.split("?")[0];
  if (path === "/v1/operations") return json(res, 200, { operations: CATALOGUE });
  if (path === "/v1/workspaces") return json(res, 200, [{ id: "ws-1", name: "brain", org_id: "o" }, { id: "ws-2", name: "other", org_id: "o" }]);
  if (req.method === "POST" && path === "/v1/uploads") {
    const asked = JSON.parse(req.body.toString("utf8")) as { workspace_id: string; purpose: string };
    const id = `up-${uploadCount++}`;
    const object = `user/${asked.workspace_id}/staging/${id}`;
    return json(res, 201, {
      upload_id: id,
      url: `${origin}/storage/v1/object/upload/sign/images/${object}?token=signed.${id}`,
      token: `signed.${id}`,
      expires_at: "2099-01-01T00:00:00Z",
      resumable: { endpoint: `${origin}/storage/v1/upload/resumable/sign`, headers: { "x-signature": `signed.${id}` }, bucket: "images", object_name: object },
    });
  }
  if (req.method === "PUT" && path.startsWith("/storage/v1/object/upload/sign/images/")) {
    stored.set(path.slice("/storage/v1/object/upload/sign/images/".length), req.body);
    return json(res, 200, { Key: path });
  }
  if (req.method === "POST" && path === "/storage/v1/upload/resumable/sign") {
    const meta = Object.fromEntries(
      String(req.headers["upload-metadata"])
        .split(",")
        .map((pair) => pair.split(" "))
        .map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]),
    );
    const id = `tus-${tus.size}`;
    tus.set(id, { object: meta.objectName, length: Number(req.headers["upload-length"]), chunks: [] });
    res.writeHead(201, { location: `/storage/v1/upload/resumable/sign/${id}`, "tus-resumable": "1.0.0" });
    return void res.end();
  }
  if (path.startsWith("/storage/v1/upload/resumable/sign/")) {
    const upload = tus.get(path.split("/").pop() ?? "");
    if (!upload) return json(res, 404, {});
    const held = upload.chunks.reduce((n, c) => n + c.byteLength, 0);
    if (req.method === "HEAD") {
      res.writeHead(200, { "upload-offset": String(held), "upload-length": String(upload.length) });
      return void res.end();
    }
    if (failNextPatch) {
      failNextPatch = false;
      return json(res, 500, { error: "lost" });
    }
    if (Number(req.headers["upload-offset"]) !== held) return json(res, 409, { error: "offset" });
    upload.chunks.push(req.body);
    const now = held + req.body.byteLength;
    if (now === upload.length) stored.set(upload.object, Buffer.concat(upload.chunks));
    res.writeHead(204, { "upload-offset": String(now) });
    return void res.end();
  }
  json(res, 404, { error: { code: "not_found", message: `No route ${req.method} ${path}` } });
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const record: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(record);
      const custom = handlers[`${record.method} ${record.url.split("?")[0]}`];
      (custom ?? builtIn)(record, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `${origin}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let dir: string;
const reset = () => {
  seen = [];
  handlers = {};
  stored = new Map();
  tus = new Map();
  uploadCount = 0;
  failNextPatch = false;
  dir = mkdtempSync(join(tmpdir(), "mdbrain-call-"));
};
reset();

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  reset();
});

const deps = (
  env: Record<string, string | undefined> = { MDBRAIN_API_KEY: KEY },
  stdin = "",
  session: () => Promise<SessionOutcome> = async () => NO_LOGIN,
): ApiCommandDeps => ({
  env: { MDBRAIN_API_URL: base, ...env },
  readStdin: async () => stdin,
  session,
});

const io = (argv: string[] = [], positional: string[] = [], flags: Record<string, string | boolean> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const written: string[] = [];
  const context: CommandContext = {
    positional,
    flags,
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    write: (text) => written.push(text),
  };
  return { context, out, err, written };
};

const apiRequests = () => seen.filter((s) => s.url.startsWith("/v1/") && s.url !== "/v1/operations");

describe("mdbrain call", () => {
  it("193-S38: with MDBRAIN_API_KEY set, `call read_file --path TODO.md` prints the JSON body and exits 0", async () => {
    const body = { file_id: "f-1", path: "TODO.md", content: "# todo\n", version: "abc" };
    handlers["GET /v1/file"] = (req, res) => json(res, 200, req.url.includes("path=TODO.md") ? body : {});
    vi.stubEnv("MDBRAIN_API_KEY", KEY);
    vi.stubEnv("MDBRAIN_API_URL", base);
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch(["call", "read_file", "--path", "TODO.md"], COMMANDS, VERSION, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual(body);
    expect(err).toEqual([]);
    const read = apiRequests();
    expect(read.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /v1/file?path=TODO.md"]);
    expect(read[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("193-S39: a 409 refusal puts the error body on stdout, the message on stderr, and exits 1", async () => {
    const refusal = { error: { code: "conflict", message: "A file named B.md already exists here" } };
    handlers["POST /v1/nodes/rename"] = (_req, res) => json(res, 409, refusal);
    const { context, out, err } = io(["rename_node", "--path", "A.md", "--new_name", "B.md"]);
    const code = await runCall(deps(), context);
    expect(code).toBe(1);
    expect(JSON.parse(out.join("\n"))).toEqual(refusal);
    expect(err.join("\n")).toContain("A file named B.md already exists here");
    expect(JSON.parse(apiRequests()[0].body.toString("utf8"))).toEqual({ path: "A.md", new_name: "B.md" });
  });

  it("193-S40: with MDBRAIN_API_KEY unset, it exits 3 and sends nothing", async () => {
    const { context, out, err } = io(["read_file", "--path", "TODO.md"]);
    const code = await runCall(deps({ MDBRAIN_API_KEY: undefined }), context);
    expect(code).toBe(3);
    expect(seen).toEqual([]);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("MDBRAIN_API_KEY");
  });

  it("193-S41: `--limit abc` where limit is a number exits 2 naming the argument and its type", async () => {
    const { context, err } = io(["list_notifications", "--limit", "abc"]);
    const code = await runCall(deps(), context);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--limit expects number/);
    expect(apiRequests()).toEqual([]);
  });

  it("193-S42: `--json args.json --path B.md` over a file saying A.md sends B.md", async () => {
    handlers["GET /v1/file"] = (_req, res) => json(res, 200, { ok: true });
    const file = join(dir, "args.json");
    writeFileSync(file, JSON.stringify({ path: "A.md", workspace_id: "ws-1" }));
    const { context } = io(["read_file", "--json", file, "--path", "B.md"]);
    expect(await runCall(deps(), context)).toBe(0);
    const query = new URLSearchParams(apiRequests()[0].url.split("?")[1]);
    expect(query.get("path")).toBe("B.md");
    expect(query.get("workspace_id")).toBe("ws-1");
  });

  it("193-S42: `--json -` reads the argument object from standard input, and a flag still overrides it", async () => {
    handlers["POST /v1/files"] = (_req, res) => json(res, 201, { path: "B.md" });
    const { context } = io(["create_file", "--json", "-", "--path", "B.md"]);
    expect(await runCall(deps(undefined, JSON.stringify({ workspace_id: "ws-1", path: "A.md", content: "x" })), context)).toBe(0);
    expect(JSON.parse(apiRequests()[0].body.toString("utf8"))).toEqual({ workspace_id: "ws-1", path: "B.md", content: "x" });
  });

  it("193-S55: arguments that come to 6 MB are staged and named with X-Arguments-Upload; 10 KB goes as a plain body", async () => {
    handlers["POST /v1/files"] = (_req, res) => json(res, 201, { path: "big.md" });
    const big = join(dir, "big.md");
    const content = "# big\n" + "a".repeat(6 * 1000 * 1000);
    writeFileSync(big, content);
    const staged = io(["create_file", "--workspace_id", "ws-1", "--path", "big.md", "--content", `@${big}`]);
    expect(await runCall(deps(), staged.context)).toBe(0);
    const begun = seen.find((s) => s.url === "/v1/uploads");
    expect(begun).toBeDefined();
    expect(JSON.parse(begun!.body.toString("utf8"))).toMatchObject({ workspace_id: "ws-1", purpose: "arguments", content_type: "application/json" });
    const commit = seen.find((s) => s.url === "/v1/files")!;
    expect(commit.headers["x-arguments-upload"]).toBe("up-0");
    expect(commit.body.byteLength).toBe(0);
    const object = [...stored.values()][0];
    expect(JSON.parse(object.toString("utf8"))).toEqual({ workspace_id: "ws-1", path: "big.md", content });
    expect(JSON.parse(begun!.body.toString("utf8")).size).toBe(object.byteLength);

    reset();
    handlers["POST /v1/files"] = (_req, res) => json(res, 201, { path: "small.md" });
    const small = join(dir, "small.md");
    writeFileSync(small, "b".repeat(10 * 1000));
    const plain = io(["create_file", "--workspace_id", "ws-1", "--path", "small.md", "--content", `@${small}`]);
    expect(await runCall(deps(), plain.context)).toBe(0);
    expect(seen.some((s) => s.url === "/v1/uploads")).toBe(false);
    const sent = seen.find((s) => s.url === "/v1/files")!;
    expect(sent.headers["x-arguments-upload"]).toBeUndefined();
    expect(JSON.parse(sent.body.toString("utf8")).content).toBe("b".repeat(10 * 1000));
  });

  it("193-S46: a 429 exits 4 and carries Retry-After on stderr", async () => {
    handlers["GET /v1/operations"] = (_req, res) =>
      json(res, 429, { error: { code: "limited", message: "Rate limit exceeded; retry after 17s" } }, { "retry-after": "17" });
    const { context, out, err } = io(["read_file", "--path", "TODO.md"]);
    const code = await runCall(deps(), context);
    expect(code).toBe(4);
    expect(err.join("\n")).toContain("Retry-After: 17");
    expect(JSON.parse(out.join("\n")).error.code).toBe("limited");
  });

  it("a 401 exits 3, and nothing printed carries the key", async () => {
    handlers["GET /v1/operations"] = (_req, res) => json(res, 401, { error: { code: "unauthenticated" } });
    const { context, out, err } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps(), context)).toBe(3);
    expect([...out, ...err].join("\n")).not.toContain(KEY);
  });

  it("an unknown operation or argument is a usage error naming what is known", async () => {
    const unknownOp = io(["no_such_op"]);
    expect(await runCall(deps(), unknownOp.context)).toBe(2);
    expect(unknownOp.err.join()).toContain("--list");
    const unknownArg = io(["read_file", "--colour", "red"]);
    expect(await runCall(deps(), unknownArg.context)).toBe(2);
    expect(unknownArg.err.join()).toContain("--path");
  });

  it("a server that cannot be reached exits 5 with an error body on stdout", async () => {
    const { context, out } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: KEY, MDBRAIN_API_URL: "http://127.0.0.1:9/v1" }), context)).toBe(5);
    expect(JSON.parse(out.join("\n")).error.code).toBe("transport");
  });

  it("--list prints name, method and route, and marks notify_person agent only", async () => {
    const { context, out } = io(["--list"]);
    expect(await runCall(deps(), context)).toBe(0);
    expect(out.find((l) => l.startsWith("notify_person"))).toMatch(/POST\s+\/v1\/notify\s+\[agent only\]$/);
    expect(out.find((l) => l.startsWith("read_file"))).not.toContain("[agent only]");
  });

  it("a {name} route segment binds its argument", async () => {
    handlers["GET /v1/threads/t%201"] = (_req, res) => json(res, 200, { id: "t 1" });
    const { context } = io(["read_thread", "--thread_id", "t 1"]);
    expect(await runCall(deps(), context)).toBe(0);
    expect(apiRequests()[0].url).toBe("/v1/threads/t%201");
  });
});

describe("mdbrain read", () => {
  it("193-S43: `read brain TODO.md` prints the document's raw content and nothing else", async () => {
    const content = "# TODO\n\n- one\n- two";
    handlers["GET /v1/file"] = (req, res) => json(res, 200, { path: "TODO.md", workspace_id: "ws-1", kind: "markdown", content, version: "v" });
    const { context, out, err, written } = io([], ["brain", "TODO.md"]);
    expect(await runRead(deps(), context)).toBe(0);
    expect(written).toEqual([content]);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    const query = new URLSearchParams(apiRequests().find((s) => s.url.startsWith("/v1/file"))!.url.split("?")[1]);
    expect(query.get("workspace_id")).toBe("ws-1");
  });

  it("193-S44: two workspaces named brain exit 2 and list both ids", async () => {
    handlers["GET /v1/workspaces"] = (_req, res) =>
      json(res, 200, [
        { id: "ws-a", name: "brain" },
        { id: "ws-b", name: "brain" },
      ]);
    const { context, err } = io([], ["brain", "TODO.md"]);
    expect(await runRead(deps(), context)).toBe(2);
    expect(err.join("\n")).toContain("ws-a");
    expect(err.join("\n")).toContain("ws-b");
    expect(seen.some((s) => s.url.startsWith("/v1/file"))).toBe(false);
  });
});

describe("mdbrain upload", () => {
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  it("193-S45: a 20 MB image is staged, sent resumably, committed, and the commit's body printed", async () => {
    const commitBody = { file_id: "img-1", path: "pics/photo.png", url: "https://example/signed" };
    handlers["POST /v1/images"] = (_req, res) => json(res, 201, commitBody);
    const bytes = Buffer.alloc(20 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
    const file = join(dir, "photo.png");
    writeFileSync(file, bytes);
    const { context, out } = io([], ["brain", file], { to: "pics" });
    expect(await runUpload(deps(), context)).toBe(0);

    const begun = JSON.parse(seen.find((s) => s.url === "/v1/uploads")!.body.toString("utf8"));
    expect(begun).toEqual({ workspace_id: "ws-1", purpose: "image", size: bytes.length, content_type: "image/png" });
    const patches = seen.filter((s) => s.method === "PATCH");
    expect(patches.length).toBe(Math.ceil(bytes.length / RESUMABLE_ABOVE));
    expect(patches.every((p) => p.headers["x-signature"] === "signed.up-0")).toBe(true);
    // The member key is for the API alone: no request to Storage carries it.
    const toStorage = seen.filter((s) => s.url.startsWith("/storage/"));
    expect(toStorage.length).toBeGreaterThan(patches.length);
    expect(toStorage.every((s) => s.headers.authorization === undefined)).toBe(true);
    expect(sha(stored.get("user/ws-1/staging/up-0")!)).toBe(sha(bytes));
    const commit = JSON.parse(seen.find((s) => s.url === "/v1/images")!.body.toString("utf8"));
    expect(commit).toEqual({ workspace_id: "ws-1", name: "photo.png", upload_id: "up-0", content_type: "image/png", parent_path: "pics" });
    expect(JSON.parse(out.join("\n"))).toEqual(commitBody);
  });

  it("a resumable chunk that fails is resent from the offset Storage holds", async () => {
    handlers["POST /v1/images"] = (_req, res) => json(res, 201, { ok: true });
    failNextPatch = true;
    const bytes = Buffer.alloc(RESUMABLE_ABOVE + 1000, 7);
    const file = join(dir, "a.png");
    writeFileSync(file, bytes);
    const { context } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(0);
    expect(seen.some((s) => s.method === "HEAD")).toBe(true);
    expect(sha(stored.get("user/ws-1/staging/up-0")!)).toBe(sha(bytes));
  });

  it("a small image goes in one PUT to the signed URL", async () => {
    handlers["POST /v1/images"] = (_req, res) => json(res, 201, { ok: true });
    const file = join(dir, "s.jpg");
    writeFileSync(file, Buffer.from("tiny"));
    const { context } = io([], ["brain", file], { name: "renamed.jpg" });
    expect(await runUpload(deps(), context)).toBe(0);
    const put = seen.find((s) => s.method === "PUT")!;
    expect(put.headers["content-type"]).toBe("image/jpeg");
    expect(put.headers.authorization).toBeUndefined();
    expect(seen.some((s) => s.method === "PATCH")).toBe(false);
    expect(JSON.parse(seen.find((s) => s.url === "/v1/images")!.body.toString("utf8")).name).toBe("renamed.jpg");
  });
});

describe("failures that leave stdout parseable", () => {
  const withTimeouts = async (shorter: Partial<typeof TIMEOUTS>, body: () => Promise<void>) => {
    const saved = { ...TIMEOUTS };
    Object.assign(TIMEOUTS, shorter);
    try {
      await body();
    } finally {
      Object.assign(TIMEOUTS, saved);
    }
  };

  it("an answer cut off mid-body exits 5 with a transport body", async () => {
    handlers["GET /v1/file"] = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"content": "half');
      setTimeout(() => res.destroy(), 20);
    };
    const { context, out } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps(), context)).toBe(5);
    expect(JSON.parse(out.join("\n")).error.code).toBe("transport");
  });

  it("an API call with no answer inside its deadline exits 5 with a transport body", async () => {
    handlers["GET /v1/file"] = (_req, res) => setTimeout(() => json(res, 200, { late: true }), 1500);
    await withTimeouts({ apiMs: 200 }, async () => {
      const { context, out, err } = io(["read_file", "--path", "TODO.md"]);
      expect(await runCall(deps(), context)).toBe(5);
      expect(JSON.parse(out.join("\n")).error.code).toBe("transport");
      expect(err.join("\n")).toContain("no answer within");
    });
  });

  it("a Storage PUT with no answer inside its deadline exits 5 with a transport body", async () => {
    handlers["PUT /storage/v1/object/upload/sign/images/user/ws-1/staging/up-0"] = (_req, res) =>
      setTimeout(() => json(res, 200, { late: true }), 1500);
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.from("tiny"));
    await withTimeouts({ storageMs: 200 }, async () => {
      const { context, out } = io([], ["brain", file]);
      expect(await runUpload(deps(), context)).toBe(5);
      expect(JSON.parse(out.join("\n")).error.code).toBe("transport");
      expect(seen.some((s) => s.url === "/v1/images")).toBe(false);
    });
  });

  it("standard input that cannot be read exits 2 with a local_file body", async () => {
    const { context, out } = io(["create_file", "--json", "-"]);
    const failing: ApiCommandDeps = { ...deps(), readStdin: () => Promise.reject(new Error("EPIPE")) };
    expect(await runCall(failing, context)).toBe(2);
    expect(JSON.parse(out.join("\n")).error.code).toBe("local_file");
  });

  it("a file that shrinks after it was measured stops the upload with exit 2 and a local_file body", async () => {
    const file = join(dir, "big.png");
    writeFileSync(file, Buffer.alloc(RESUMABLE_ABOVE + 1000, 1));
    handlers["POST /v1/uploads"] = (req, res) => {
      truncateSync(file, 0);
      builtIn(req, res);
    };
    let patches = 0;
    handlers["PATCH /storage/v1/upload/resumable/sign/tus-0"] = (req, res) => (++patches > 12 ? json(res, 400, {}) : builtIn(req, res));
    const { context, out } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(2);
    expect(JSON.parse(out.join("\n")).error).toMatchObject({ code: "local_file", message: expect.stringContaining("changed") });
    expect(patches).toBe(0);
  });

  it("a resumable upload that Storage keeps losing gives up after rounds without progress", async () => {
    const file = join(dir, "big.png");
    writeFileSync(file, Buffer.alloc(2 * RESUMABLE_ABOVE + 1000, 1));
    let patches = 0;
    // Takes every chunk at offset 0 and fails every other, and its HEAD (the
    // fake's own) reports nothing held, so the upload never gets past 6 MB.
    handlers["PATCH /storage/v1/upload/resumable/sign/tus-0"] = (req, res) => {
      patches++;
      if (patches > 12) return json(res, 400, { error: "enough" });
      if (req.headers["upload-offset"] === "0") {
        res.writeHead(204, { "upload-offset": String(req.body.byteLength) });
        return void res.end();
      }
      json(res, 500, { error: "lost" });
    };
    const { context, out } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(5);
    expect(JSON.parse(out.join("\n")).error.code).toBe("storage");
    expect(patches).toBe(4);
  });

  it("a refusal's body on stdout is redacted, JSON or not", async () => {
    handlers["POST /v1/nodes/rename"] = (_req, res) => json(res, 400, { error: { code: "bad", message: `saw Authorization: Bearer ${KEY}` } });
    const jsonRefusal = io(["rename_node", "--path", "A.md", "--new_name", "B.md"]);
    expect(await runCall(deps(), jsonRefusal.context)).toBe(1);
    expect(jsonRefusal.out.join("\n")).not.toContain(KEY);
    expect(jsonRefusal.err.join("\n")).not.toContain(KEY);
    expect(JSON.parse(jsonRefusal.out.join("\n")).error.message).toContain("[redacted]");

    handlers["POST /v1/nodes/rename"] = (_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end(`<html>bad gateway for ${KEY}</html>`);
    };
    const pageRefusal = io(["rename_node", "--path", "A.md", "--new_name", "B.md"]);
    expect(await runCall(deps(), pageRefusal.context)).toBe(5);
    expect(pageRefusal.out.join("\n")).not.toContain(KEY);
    expect(pageRefusal.err.join("\n")).not.toContain(KEY);
    expect(JSON.parse(pageRefusal.out.join("\n")).error.code).toBe("http_502");
  });

  it("a Storage refusal that echoes the key or a signed token is redacted on stdout and stderr alike", async () => {
    const signed = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1cC0wIn0.c2lnbmF0dXJlLWJ5dGVz";
    handlers["PUT /storage/v1/object/upload/sign/images/user/ws-1/staging/up-0"] = (_req, res) =>
      json(res, 403, { error: "denied", saw: `Bearer ${KEY} and token ${signed}` });
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.from("tiny"));
    const { context, out, err } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).not.toBe(0);
    const printed = [...out, ...err].join("\n");
    expect(printed).toContain("[redacted]");
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain(signed);
    expect(seen.some((s) => s.url === "/v1/images")).toBe(false);
  });

  it("an API answer that redirects is refused as a transport failure, and the redirect is not followed", async () => {
    handlers["GET /v1/file"] = (_req, res) => {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    };
    const { context, out } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps(), context)).toBe(5);
    expect(JSON.parse(out.join("\n")).error.code).toBe("transport");
    expect(seen.some((s) => s.url.startsWith("/elsewhere"))).toBe(false);
  });

  it("`read` and `upload` with MDBRAIN_API_KEY unset exit 3 and send nothing", async () => {
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.from("tiny"));
    const reading = io([], ["brain", "TODO.md"]);
    expect(await runRead(deps({ MDBRAIN_API_KEY: undefined }), reading.context)).toBe(3);
    const uploading = io([], ["brain", file]);
    expect(await runUpload(deps({ MDBRAIN_API_KEY: undefined }), uploading.context)).toBe(3);
    expect(seen).toEqual([]);
    expect([...reading.err, ...uploading.err].join("\n")).toContain("MDBRAIN_API_KEY");
  });

  it("`read` of something with no text exits 1 with a not_text body", async () => {
    handlers["GET /v1/file"] = (_req, res) => json(res, 200, { path: "pic.png", kind: "image" });
    const { context, out, written } = io([], ["brain", "pic.png"]);
    expect(await runRead(deps(), context)).toBe(1);
    expect(written).toEqual([]);
    expect(JSON.parse(out.join("\n")).error.code).toBe("not_text");
  });

  it("`upload` tells a missing file from a directory and from any other failure", async () => {
    const missing = io([], ["brain", join(dir, "nope.png")]);
    expect(await runUpload(deps(), missing.context)).toBe(2);
    expect(missing.err.join()).toContain("no such file");

    const folder = io([], ["brain", dir]);
    expect(await runUpload(deps(), folder.context)).toBe(2);
    expect(folder.err.join()).toContain("not a file");
    expect(JSON.parse(folder.out.join("\n")).error.code).toBe("local_file");

    const invalid = io([], ["brain", "bad\0name.png"]);
    expect(await runUpload(deps(), invalid.context)).toBe(2);
    expect(invalid.err.join()).toContain("ERR_INVALID_ARG_VALUE");
    expect(invalid.err.join()).not.toContain("no such file");
    expect(seen).toEqual([]);
  });
});

describe("call's own words", () => {
  it("`-v` after an argument is a value, and `call --help` is still help", async () => {
    handlers["GET /v1/file"] = (_req, res) => json(res, 200, { ok: true });
    vi.stubEnv("MDBRAIN_API_KEY", KEY);
    vi.stubEnv("MDBRAIN_API_URL", base);
    const out: string[] = [];
    const sink = { out: (l: string) => out.push(l), err: () => undefined };
    expect(await dispatch(["call", "read_file", "--path", "-v"], COMMANDS, VERSION, sink)).toBe(0);
    expect(out).not.toContain(VERSION);
    expect(apiRequests().map((s) => s.url)).toEqual(["/v1/file?path=-v"]);

    out.length = 0;
    expect(await dispatch(["call", "--help"], COMMANDS, VERSION, sink)).toBe(0);
    expect(out.join("\n")).toContain("--stage-in");
  });

  it("arguments over 4 MB for an operation with no workspace_id are staged in --stage-in's workspace, which is not sent", async () => {
    handlers["POST /v1/nodes/rename"] = (_req, res) => json(res, 200, { ok: true });
    const big = join(dir, "name.txt");
    writeFileSync(big, "n".repeat(STAGE_ARGUMENTS_ABOVE + 10));

    const without = io(["rename_node", "--path", "A.md", "--new_name", `@${big}`]);
    expect(await runCall(deps(), without.context)).toBe(2);
    expect(without.err.join()).toContain("--stage-in");
    expect(seen.some((s) => s.url === "/v1/uploads")).toBe(false);

    const staged = io(["rename_node", "--path", "A.md", "--new_name", `@${big}`, "--stage-in", "other"]);
    expect(await runCall(deps(), staged.context)).toBe(0);
    expect(JSON.parse(seen.find((s) => s.url === "/v1/uploads")!.body.toString("utf8")).workspace_id).toBe("ws-2");
    expect(Object.keys(JSON.parse([...stored.values()][0].toString("utf8")))).toEqual(["path", "new_name"]);
    expect(seen.find((s) => s.url === "/v1/nodes/rename")!.headers["x-arguments-upload"]).toBe("up-0");
  });

  it("a workspace given by its id is not looked up", async () => {
    const id = "0b9c2f1e-1d2c-4b3a-9f8e-7d6c5b4a3f21";
    handlers["GET /v1/workspaces"] = (_req, res) => json(res, 200, [{ id, name: "brain" }]);
    handlers["GET /v1/file"] = (_req, res) => json(res, 200, { kind: "markdown", content: "x" });
    const { context, written } = io([], [id, "TODO.md"]);
    expect(await runRead(deps(), context)).toBe(0);
    expect(written).toEqual(["x"]);
    expect(seen.some((s) => s.url === "/v1/workspaces")).toBe(false);
    expect(new URLSearchParams(apiRequests()[0].url.split("?")[1]).get("workspace_id")).toBe(id);
  });

  it("`upload --name` without an extension takes the type from the local file", async () => {
    handlers["POST /v1/images"] = (_req, res) => json(res, 201, { ok: true });
    const file = join(dir, "s.jpg");
    writeFileSync(file, Buffer.from("tiny"));
    const { context } = io([], ["brain", file], { name: "renamed" });
    expect(await runUpload(deps(), context)).toBe(0);
    expect(seen.find((s) => s.method === "PUT")!.headers["content-type"]).toBe("image/jpeg");
    expect(JSON.parse(seen.find((s) => s.url === "/v1/images")!.body.toString("utf8"))).toMatchObject({ name: "renamed", content_type: "image/jpeg" });
  });
});

describe("the pure core", () => {
  it("reads three or more dashes as a value, and says how to send one that starts with --", () => {
    expect(parseCall(["create_file", "--content", "---\ntitle: x\n---", "--path", "a.md"])).toMatchObject({
      ok: true,
      value: { flags: [{ name: "content", value: "---\ntitle: x\n---" }, { name: "path", value: "a.md" }] },
    });
    const bare = coerceValue("content", true, { type: "string" });
    expect(bare.ok).toBe(false);
    expect(!bare.ok && bare.message).toContain("--content=value");
  });

  it("takes a type only from a real extension, the local file's first", () => {
    expect(mimeFor("png")).toBe("application/octet-stream");
    expect(mimeFor("a.png")).toBe("image/png");
    expect(mimeFor("dir.png/photo", "x.gif")).toBe("image/gif");
    expect(mimeFor("photo.jpg", "renamed.png")).toBe("image/jpeg");
  });

  it("knows a workspace id from a name", () => {
    expect(isWorkspaceId("0b9c2f1e-1d2c-4b3a-9f8e-7d6c5b4a3f21")).toBe(true);
    expect(isWorkspaceId("brain")).toBe(false);
    expect(isWorkspaceId("ws-1")).toBe(false);
  });

  it("maps statuses to exit codes", () => {
    expect([200, 201, 400, 401, 403, 404, 409, 413, 429, 500, 503].map(exitForStatus)).toEqual([0, 0, 1, 3, 1, 1, 1, 1, 4, 5, 5]);
    expect(EXIT).toEqual({ ok: 0, refused: 1, usage: 2, auth: 3, limited: 4, transport: 5 });
  });

  it("coerces typed values by the argument's schema", () => {
    expect(coerceValue("n", "5", { type: "number" })).toEqual({ ok: true, value: 5 });
    expect(coerceValue("n", "5.5", { type: "integer" }).ok).toBe(false);
    expect(coerceValue("b", true, { type: "boolean" })).toEqual({ ok: true, value: true });
    expect(coerceValue("b", "false", { type: "boolean" })).toEqual({ ok: true, value: false });
    expect(coerceValue("s", true, { type: "string" }).ok).toBe(false);
    expect(coerceValue("a", '["x","y"]', { type: "array" })).toEqual({ ok: true, value: ["x", "y"] });
    expect(coerceValue("a", "x,y", { type: "array" }).ok).toBe(false);
    expect(coerceValue("p", "null", { anyOf: [{ type: "string" }, { type: "null" }] })).toEqual({ ok: true, value: "null" });
    expect(coerceValue("p", "null", { type: ["number", "null"] })).toEqual({ ok: true, value: null });
  });

  it("parses a call's words: values may be - or negative, --name=value keeps a leading --", () => {
    expect(parseCall(["op", "--json", "-", "--n", "-3", "--s=--x", "--stage-in", "brain", "--flag"])).toEqual({
      ok: true,
      value: {
        kind: "call",
        operation: "op",
        json: "-",
        stageIn: "brain",
        flags: [{ name: "n", value: "-3" }, { name: "s", value: "--x" }, { name: "flag", value: true }],
      },
    });
    expect(parseCall(["op", "--stage-in"]).ok).toBe(false);
    expect(parseCall(["--list"])).toEqual({ ok: true, value: { kind: "list" } });
    expect(parseCall([]).ok).toBe(false);
    expect(parseCall(["a", "b"]).ok).toBe(false);
  });

  it("reads @file as a file and @@ as a literal @", () => {
    expect(valueSource("@big.md")).toEqual({ kind: "file", path: "big.md" });
    expect(valueSource("@@Diego done")).toEqual({ kind: "literal", text: "@Diego done" });
    expect(valueSource("plain")).toEqual({ kind: "literal", text: "plain" });
  });

  it("stages above the API's body limit and not at it", () => {
    expect(shouldStage(STAGE_ARGUMENTS_ABOVE)).toBe(false);
    expect(shouldStage(STAGE_ARGUMENTS_ABOVE + 1)).toBe(true);
  });

  it("holds its two thresholds to the spec's numbers: the API's 4 MB body limit and 6 MB resumable chunks", () => {
    // Every other case reads these constants back, so a case of its own is what
    // notices one moved; the server's `express.json` limit is the same 4 MB.
    expect(STAGE_ARGUMENTS_ABOVE).toBe(4 * 1024 * 1024);
    expect(RESUMABLE_ABOVE).toBe(6 * 1024 * 1024);
  });

  it("plans a route-bound argument as a segment, and refuses one missing", () => {
    const entry = CATALOGUE.find((e) => e.name === "read_thread")!;
    expect(planRequest(entry, {}).ok).toBe(false);
    expect(planRequest(entry, { thread_id: "t" })).toMatchObject({ ok: true, value: { route: "/threads/t", inQuery: true, query: "" } });
  });

  it("resolves a workspace by id or exact name", () => {
    const rows = [
      { id: "a", name: "brain" },
      { id: "b", name: "brain" },
      { id: "c", name: "solo" },
    ];
    expect(resolveWorkspace(rows, "c")).toEqual({ ok: true, value: rows[2] });
    expect(resolveWorkspace(rows, "solo")).toEqual({ ok: true, value: rows[2] });
    expect(resolveWorkspace(rows, "brain").ok).toBe(false);
    expect(resolveWorkspace(rows, "nope").ok).toBe(false);
  });

  it("lists aligned rows", () => {
    expect(renderList(CATALOGUE.slice(0, 1))).toEqual(["read_file  GET  /v1/file"]);
  });

  it("takes the API address from MDBRAIN_API_URL, else the constant", () => {
    expect(apiBase({})).toEqual({ ok: true, value: API_URL });
    expect(API_URL).toBe("https://api.markdownbrain.ai/v1");
    expect(apiBase({ MDBRAIN_API_URL: "http://127.0.0.1:3001/v1/" })).toEqual({ ok: true, value: "http://127.0.0.1:3001/v1" });
  });

  it("193-S64: takes plain http only to this machine, and https anywhere", () => {
    expect(apiBase({ MDBRAIN_API_URL: "http://localhost:3001/v1" }).ok).toBe(true);
    expect(apiBase({ MDBRAIN_API_URL: "http://[::1]:3001/v1" }).ok).toBe(true);
    expect(apiBase({ MDBRAIN_API_URL: "http://[0:0:0:0:0:0:0:1]:3001/v1" }).ok).toBe(true);
    expect(apiBase({ MDBRAIN_API_URL: "http://127.0.0.2:3001/v1" }).ok).toBe(true);
    expect(apiBase({ MDBRAIN_API_URL: "http://127.0.0.1.example/v1" }).ok).toBe(false);
    expect(apiBase({ MDBRAIN_API_URL: "https://staging.example/v1" }).ok).toBe(true);
    expect(apiBase({ MDBRAIN_API_URL: "http://api.markdownbrain.ai/v1" })).toMatchObject({ ok: false, message: expect.stringContaining("https") });
    expect(apiBase({ MDBRAIN_API_URL: "http://localhost.example/v1" }).ok).toBe(false);
    expect(apiBase({ MDBRAIN_API_URL: "ftp://localhost/v1" }).ok).toBe(false);
    expect(apiBase({ MDBRAIN_API_URL: "api.markdownbrain.ai/v1" }).ok).toBe(false);
  });

  it("reads Upload-Offset as a count only when there is one", () => {
    expect(uploadOffset(null)).toBeNull();
    expect(uploadOffset("")).toBeNull();
    expect(uploadOffset("abc")).toBeNull();
    expect(uploadOffset("-1")).toBeNull();
    expect(uploadOffset("0")).toBe(0);
    expect(uploadOffset(" 6291456 ")).toBe(6291456);
  });
});

describe("the address and the answers the client trusts", () => {
  it("193-S64: MDBRAIN_API_URL naming plain http to another host exits 2 and sends nothing", async () => {
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.from("tiny"));
    for (const run of [
      () => runUpload(deps({ MDBRAIN_API_KEY: KEY, MDBRAIN_API_URL: "http://api.markdownbrain.ai/v1" }), io([], ["brain", file]).context),
      () => runCall(deps({ MDBRAIN_API_KEY: KEY, MDBRAIN_API_URL: "http://api.markdownbrain.ai/v1" }), io(["read_file", "--path", "A.md"]).context),
      () => runRead(deps({ MDBRAIN_API_KEY: KEY, MDBRAIN_API_URL: "http://api.markdownbrain.ai/v1" }), io([], ["brain", "A.md"]).context),
    ]) {
      expect(await run()).toBe(EXIT.usage);
    }
    expect(seen).toEqual([]);
  });

  it("193-S65: an operation list that is a portal's page exits 5 and prints no list", async () => {
    handlers["GET /v1/operations"] = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>Sign in to the wifi</html>");
    };
    const { context, out } = io(["--list"]);
    expect(await runCall(deps(), context)).toBe(EXIT.transport);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]).error.code).toBe("transport");
  });

  it("193-S65: an operation list of another shape exits 5, not unknown operation", async () => {
    handlers["GET /v1/operations"] = (_req, res) => json(res, 200, { hello: "proxy" });
    const { context, out } = io(["read_file", "--path", "A.md"]);
    expect(await runCall(deps(), context)).toBe(EXIT.transport);
    expect(JSON.parse(out.join("\n")).error.code).toBe("transport");
  });

  it("193-S65: an upload begun with no address exits 5 and sends no bytes", async () => {
    handlers["POST /v1/uploads"] = (_req, res) => json(res, 201, { upload_id: "up-0" });
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.from("tiny"));
    const { context, out } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(EXIT.transport);
    expect(JSON.parse(out.join("\n")).error).toMatchObject({ code: "transport", message: expect.stringContaining("Expected an upload") });
    expect(seen.some((s) => s.url.startsWith("/storage/"))).toBe(false);
  });

  it("193-S65: a workspace list or a document that is not JSON, or not the shape the API sends, exits 5", async () => {
    const page = (_req: Seen, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>portal</html>");
    };
    handlers["GET /v1/workspaces"] = page;
    expect(await runRead(deps(), io([], ["brain", "A.md"]).context)).toBe(EXIT.transport);
    handlers = { "GET /v1/file": page };
    expect(await runRead(deps(), io([], ["ws-1", "A.md"]).context)).toBe(EXIT.transport);
    handlers = { "GET /v1/workspaces": (_req, res) => json(res, 200, { rows: [] }) };
    const { context, out } = io([], ["brain", "A.md"]);
    expect(await runRead(deps(), context)).toBe(EXIT.transport);
    expect(JSON.parse(out.join("\n")).error.message).toContain("the workspaces you can reach");
    // JSON that is not a file read, so not a document with no text either.
    handlers = { "GET /v1/file": (_req, res) => json(res, 200, { status: "ok" }) };
    const notARead = io([], ["ws-1", "A.md"]);
    expect(await runRead(deps(), notARead.context)).toBe(EXIT.transport);
    expect(JSON.parse(notARead.out.join("\n")).error.code).toBe("transport");
  });

  it("193-S65: an operation list whose entries lack a method or a route exits 5, not an internal error", async () => {
    handlers["GET /v1/operations"] = (_req, res) => json(res, 200, { operations: [{ name: "read_file" }] });
    const { context, out } = io(["--list"]);
    expect(await runCall(deps(), context)).toBe(EXIT.transport);
    expect(JSON.parse(out.join("\n")).error.code).toBe("transport");
  });

  // One field missing at a time: an entry lacking two is refused by whichever is checked first.
  it("193-S65: an operation entry lacking any one of its name, method or route exits 5", async () => {
    const whole = { name: "read_file", method: "GET", path: "/v1/file" };
    for (const field of ["name", "method", "path"] as const) {
      const { [field]: _dropped, ...entry } = whole;
      handlers["GET /v1/operations"] = (_req, res) => json(res, 200, { operations: [entry] });
      const { context, out } = io(["--list"]);
      expect(await runCall(deps(), context), field).toBe(EXIT.transport);
      expect(JSON.parse(out.join("\n")).error.code, field).toBe("transport");
    }
  });

  // The document answers, so a row let through reads as a success or a usage error, never as 5.
  it("193-S65: a workspace row lacking its id or its name, or not an object, exits 5", async () => {
    handlers["GET /v1/file"] = (_req, res) => json(res, 200, { kind: "document", content: "x" });
    for (const rows of [[{ id: "ws-1" }], [{ name: "brain" }], ["brain"]]) {
      handlers["GET /v1/workspaces"] = (_req, res) => json(res, 200, rows);
      const { context, out } = io([], ["brain", "A.md"]);
      expect(await runRead(deps(), context), JSON.stringify(rows)).toBe(EXIT.transport);
      expect(JSON.parse(out.join("\n")).error.code).toBe("transport");
    }
  });

  // A small file goes in one PUT and never touches `resumable`, so a shape let through would commit and exit 0.
  it("193-S65: an upload begun without its id, or with a resumable part missing any field, exits 5 and sends no bytes", async () => {
    handlers["POST /v1/images"] = (_req, res) => json(res, 201, { ok: true });
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.from("tiny"));
    const drops: Array<[string, (b: Record<string, any>) => void]> = [
      ["upload_id", (b) => delete b.upload_id],
      ["resumable.endpoint", (b) => delete b.resumable.endpoint],
      ["resumable.headers", (b) => delete b.resumable.headers],
      ["resumable.bucket", (b) => delete b.resumable.bucket],
      ["resumable.object_name", (b) => delete b.resumable.object_name],
    ];
    for (const [field, drop] of drops) {
      handlers["POST /v1/uploads"] = (_req, res) => {
        const object = "user/ws-1/staging/up-0";
        const body: Record<string, any> = {
          upload_id: "up-0",
          url: `${origin}/storage/v1/object/upload/sign/images/${object}?token=signed.up-0`,
          resumable: { endpoint: `${origin}/storage/v1/upload/resumable/sign`, headers: { "x-signature": "signed.up-0" }, bucket: "images", object_name: object },
        };
        drop(body);
        json(res, 201, body);
      };
      const before = seen.length;
      const { context, out } = io([], ["brain", file]);
      expect(await runUpload(deps(), context), field).toBe(EXIT.transport);
      expect(JSON.parse(out.join("\n")).error.code, field).toBe("transport");
      expect(seen.slice(before).some((s) => s.url.startsWith("/storage/") || s.url === "/v1/images"), field).toBe(false);
    }
  });
});

describe("a file that changes while it is sent", () => {
  const big = () => {
    const bytes = Buffer.alloc(2 * RESUMABLE_ABOVE + 1000);
    for (let i = 0; i < bytes.length; i += 997) bytes[i] = i % 251;
    const file = join(dir, "big.png");
    writeFileSync(file, bytes);
    return file;
  };

  it("193-S66: one that grows between chunks stops with exit 2, and nothing is committed", async () => {
    const file = big();
    let patches = 0;
    handlers["PATCH /storage/v1/upload/resumable/sign/tus-0"] = (req, res) => {
      if (++patches === 1) appendFileSync(file, Buffer.alloc(1000, 9));
      builtIn(req, res);
    };
    const { context, out } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(EXIT.usage);
    expect(JSON.parse(out.join("\n")).error).toMatchObject({ code: "local_file", message: expect.stringContaining("changed") });
    expect(seen.some((s) => s.url === "/v1/images")).toBe(false);
  });

  it("193-S66: one rewritten at the same size between chunks stops with exit 2", async () => {
    const file = big();
    let patches = 0;
    handlers["PATCH /storage/v1/upload/resumable/sign/tus-0"] = (req, res) => {
      if (++patches === 1) {
        writeFileSync(file, Buffer.alloc(2 * RESUMABLE_ABOVE + 1000, 3));
        const later = new Date(Date.now() + 5000);
        utimesSync(file, later, later);
      }
      builtIn(req, res);
    };
    const { context, out } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(EXIT.usage);
    expect(JSON.parse(out.join("\n")).error.message).toContain("at the same size");
    expect(seen.some((s) => s.url === "/v1/images")).toBe(false);
  });

  it("193-S66: one saved over by a rename between chunks lets the save through and stops the upload", async () => {
    const file = big();
    handlers["POST /v1/images"] = (_req, res) => json(res, 201, { ok: true });
    let patches = 0;
    handlers["PATCH /storage/v1/upload/resumable/sign/tus-0"] = (req, res) => {
      if (++patches === 1) {
        // How an editor saves: a new file, renamed over the old one.
        const temp = join(dir, "big.png.tmp");
        writeFileSync(temp, Buffer.alloc(3 * RESUMABLE_ABOVE, 5));
        renameSync(temp, file);
      }
      builtIn(req, res);
    };
    expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(EXIT.usage);
    expect(readFileSync(file).equals(Buffer.alloc(3 * RESUMABLE_ABOVE, 5))).toBe(true);
    expect(seen.some((s) => s.url === "/v1/images")).toBe(false);
  });

  it("193-S66: one copied over in place at the same size, its modification time put back, stops with exit 2", async () => {
    const file = big();
    // A whole second, so the time put back is exactly the time measured.
    const measured = new Date(1_700_000_000_000);
    utimesSync(file, measured, measured);
    let patches = 0;
    handlers["PATCH /storage/v1/upload/resumable/sign/tus-0"] = (req, res) => {
      if (++patches === 1) {
        // How `cp -p` or `rsync -t` lands on a file that exists: new bytes in place, then the old time.
        writeFileSync(file, Buffer.alloc(2 * RESUMABLE_ABOVE + 1000, 4));
        utimesSync(file, measured, measured);
      }
      builtIn(req, res);
    };
    const { context, out } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(EXIT.usage);
    expect(JSON.parse(out.join("\n")).error.code).toBe("local_file");
    expect(seen.some((s) => s.url === "/v1/images")).toBe(false);
  });

  it("193-S66: a small one that grows before its one PUT stops with exit 2 and sends nothing", async () => {
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.from("tiny"));
    handlers["POST /v1/uploads"] = (req, res) => {
      appendFileSync(file, "more");
      builtIn(req, res);
    };
    const { context } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(EXIT.usage);
    expect(seen.some((s) => s.method === "PUT")).toBe(false);
  });
});

describe("the resumable upload's recovery", () => {
  const TUS = "/storage/v1/upload/resumable/sign/tus-0";
  const big = (size = 2 * RESUMABLE_ABOVE + 1000) => {
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < bytes.length; i += 991) bytes[i] = i % 241;
    const file = join(dir, "big.png");
    writeFileSync(file, bytes);
    handlers["POST /v1/images"] = (_req, res) => json(res, 201, { ok: true });
    return { file, bytes };
  };
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  /** Keeps a chunk the way the fake's own PATCH does, without answering. */
  const keep = (body: Buffer) => {
    const upload = tus.get("tus-0")!;
    upload.chunks.push(body);
    const held = upload.chunks.reduce((n, c) => n + c.byteLength, 0);
    if (held === upload.length) stored.set(upload.object, Buffer.concat(upload.chunks));
    return held;
  };
  const patchOffsets = () => seen.filter((x) => x.method === "PATCH").map((x) => Number(x.headers["upload-offset"]));
  const withTimeouts = async (shorter: Partial<typeof TIMEOUTS>, body: () => Promise<void>) => {
    const saved = { ...TIMEOUTS };
    Object.assign(TIMEOUTS, shorter);
    try {
      await body();
    } finally {
      Object.assign(TIMEOUTS, saved);
    }
  };

  it("carries on from the offset a 204 reports, when Storage kept less than was sent", async () => {
    const { file, bytes } = big();
    let patches = 0;
    const half = RESUMABLE_ABOVE / 2;
    handlers[`PATCH ${TUS}`] = (req, res) => {
      if (++patches > 1) return builtIn(req, res);
      const held = keep(req.body.subarray(0, half));
      res.writeHead(204, { "upload-offset": String(held) });
      res.end();
    };
    expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(0);
    expect(patchOffsets()[1]).toBe(half);
    expect(sha(stored.get("user/ws-1/staging/up-0")!)).toBe(sha(bytes));
  });

  it("asks what Storage holds after a failed chunk, and does not resend what it kept", async () => {
    const { file, bytes } = big();
    let patches = 0;
    handlers[`PATCH ${TUS}`] = (req, res) => {
      if (++patches > 1) return builtIn(req, res);
      keep(req.body);
      json(res, 500, { error: "kept it, then lost the answer" });
    };
    expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(0);
    expect(patchOffsets().slice(0, 2)).toEqual([0, RESUMABLE_ABOVE]);
    expect(sha(stored.get("user/ws-1/staging/up-0")!)).toBe(sha(bytes));
  });

  it("193-S67: a HEAD with no Upload-Offset keeps the client's own count, not zero", async () => {
    const { file, bytes } = big();
    let patches = 0;
    handlers[`PATCH ${TUS}`] = (req, res) => (++patches === 2 ? json(res, 500, { error: "lost" }) : builtIn(req, res));
    handlers[`HEAD ${TUS}`] = (_req, res) => {
      res.writeHead(200, {});
      res.end();
    };
    expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(0);
    expect(patchOffsets().slice(0, 3)).toEqual([0, RESUMABLE_ABOVE, RESUMABLE_ABOVE]);
    expect(sha(stored.get("user/ws-1/staging/up-0")!)).toBe(sha(bytes));
  });

  it("forgives failures between chunks that make progress, so only a run of stalls gives up", async () => {
    const { file, bytes } = big();
    let patches = 0;
    // Two failures before every chunk that lands: never three stalls in a row.
    handlers[`PATCH ${TUS}`] = (req, res) => (++patches % 3 !== 0 ? json(res, 500, { error: "lost" }) : builtIn(req, res));
    expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(0);
    expect(patches).toBe(9);
    expect(sha(stored.get("user/ws-1/staging/up-0")!)).toBe(sha(bytes));
  });

  it("stops at once on a 4xx refusal of a chunk, without asking again", async () => {
    const { file } = big();
    handlers[`PATCH ${TUS}`] = (_req, res) => json(res, 403, { error: "signature expired" });
    const { context, out } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(EXIT.refused);
    expect(JSON.parse(out.join("\n")).error.code).toBe("storage");
    expect(seen.filter((x) => x.method === "PATCH")).toHaveLength(1);
    expect(seen.some((x) => x.method === "HEAD")).toBe(false);
  });

  it("asks again after a 409 over the offset", async () => {
    const { file, bytes } = big();
    let patches = 0;
    handlers[`PATCH ${TUS}`] = (req, res) => (++patches === 1 ? json(res, 409, { error: "offset" }) : builtIn(req, res));
    expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(0);
    expect(sha(stored.get("user/ws-1/staging/up-0")!)).toBe(sha(bytes));
  });

  it("refuses a create that is not a 201, or that does not say where the upload is", async () => {
    const { file } = big();
    handlers["POST /storage/v1/upload/resumable/sign"] = (_req, res) =>
      json(res, 200, { odd: true }, { location: "/storage/v1/upload/resumable/sign/tus-0" });
    const notCreated = io([], ["brain", file]);
    expect(await runUpload(deps(), notCreated.context)).toBe(EXIT.refused);
    expect(JSON.parse(notCreated.out.join("\n")).error.message).toContain("HTTP 200");
    handlers["POST /storage/v1/upload/resumable/sign"] = (_req, res) => {
      res.writeHead(201, {});
      res.end();
    };
    expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(EXIT.refused);
    expect(seen.some((x) => x.method === "PATCH")).toBe(false);
  });

  it("a resumable create with no answer inside its deadline exits 5", async () => {
    const { file } = big();
    handlers["POST /storage/v1/upload/resumable/sign"] = () => undefined;
    await withTimeouts({ storageMs: 200 }, async () => {
      const { context, out } = io([], ["brain", file]);
      expect(await runUpload(deps(), context)).toBe(EXIT.transport);
      expect(JSON.parse(out.join("\n")).error.code).toBe("transport");
    });
  });

  it("a chunk with no answer inside its deadline is recovered through what Storage holds", async () => {
    const { file, bytes } = big();
    let patches = 0;
    handlers[`PATCH ${TUS}`] = (req, res) => (++patches === 2 ? undefined : builtIn(req, res));
    await withTimeouts({ storageMs: 1500, storageBytesPerMs: 1e12 }, async () => {
      expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(0);
    });
    expect(seen.some((x) => x.method === "HEAD")).toBe(true);
    expect(sha(stored.get("user/ws-1/staging/up-0")!)).toBe(sha(bytes));
  });

  it("a HEAD with no answer inside its deadline falls back to the client's own count", async () => {
    const { file, bytes } = big();
    let patches = 0;
    handlers[`PATCH ${TUS}`] = (req, res) => (++patches === 2 ? json(res, 500, { error: "lost" }) : builtIn(req, res));
    handlers[`HEAD ${TUS}`] = () => undefined;
    await withTimeouts({ storageMs: 1500, storageBytesPerMs: 1e12 }, async () => {
      expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(0);
    });
    expect(sha(stored.get("user/ws-1/staging/up-0")!)).toBe(sha(bytes));
  });

  it("gives a Storage request more time for more bytes", async () => {
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.alloc(2000, 1));
    handlers["POST /v1/images"] = (_req, res) => json(res, 201, { ok: true });
    handlers["PUT /storage/v1/object/upload/sign/images/user/ws-1/staging/up-0"] = (req, res) => setTimeout(() => builtIn(req, res), 600);
    // 200 ms for any request, plus 1 ms per byte: 2000 bytes earn 2.2 s.
    await withTimeouts({ storageMs: 200, storageBytesPerMs: 1 }, async () => {
      expect(await runUpload(deps(), io([], ["brain", file]).context)).toBe(0);
    });
  });

  it("sends a file of exactly 6 MiB in one PUT, and one byte more resumably", async () => {
    const exact = big(RESUMABLE_ABOVE);
    expect(await runUpload(deps(), io([], ["brain", exact.file]).context)).toBe(0);
    expect(seen.some((x) => x.method === "PUT")).toBe(true);
    expect(seen.some((x) => x.method === "PATCH")).toBe(false);
    reset();
    const over = big(RESUMABLE_ABOVE + 1);
    expect(await runUpload(deps(), io([], ["brain", over.file]).context)).toBe(0);
    expect(seen.some((x) => x.method === "PATCH")).toBe(true);
  });

  it("a Storage refusal of a one-PUT upload exits 1", async () => {
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.from("tiny"));
    handlers["PUT /storage/v1/object/upload/sign/images/user/ws-1/staging/up-0"] = (_req, res) => json(res, 403, { error: "expired" });
    const { context, out } = io([], ["brain", file]);
    expect(await runUpload(deps(), context)).toBe(EXIT.refused);
    expect(JSON.parse(out.join("\n")).error.code).toBe("storage");
  });
});

describe("what goes on the wire, and what never leaves", () => {
  it("encodes a {name} segment whole, so a slash or a ? in it cannot move the route", async () => {
    const id = "a/b?c#d %";
    await runCall(deps(), io(["read_thread", "--thread_id", id]).context);
    expect(apiRequests()[0].url).toBe(`/v1/threads/${encodeURIComponent(id)}`);
  });

  it("encodes query values, so & = # + in a path arrive as written", async () => {
    const path = "A&B=C#D+E%.md";
    await runCall(deps(), io(["read_file", "--path", path]).context);
    expect(new URLSearchParams(apiRequests()[0].url.split("?")[1]).get("path")).toBe(path);
  });

  it("measures staging in bytes, not characters", async () => {
    // 2.2 million two-byte characters: under 4 MB as characters, over it as bytes.
    const name = "é".repeat(2_200_000);
    await runCall(deps(), io(["rename_node", "--path", "A.md", "--new_name", name, "--stage-in", "brain"]).context);
    expect(seen.some((x) => x.url === "/v1/uploads")).toBe(true);
  });

  it("a key of only whitespace is no key: exit 3, nothing sent", async () => {
    expect(await runCall(deps({ MDBRAIN_API_KEY: "   " }), io(["read_file", "--path", "A.md"]).context)).toBe(EXIT.auth);
    expect(seen).toEqual([]);
  });

  it("every usage error exits 2 and sends no operation", async () => {
    writeFileSync(join(dir, "bad.json"), "{ not json");
    writeFileSync(join(dir, "list.json"), "[1, 2]");
    const cases: [string, () => Promise<number>][] = [
      ["no operation", () => runCall(deps(), io([]).context)],
      ["--json that is not JSON", () => runCall(deps(), io(["read_file", "--json", join(dir, "bad.json")]).context)],
      ["--json that is not an object", () => runCall(deps(), io(["read_file", "--json", join(dir, "list.json")]).context)],
      ["an @file that is missing", () => runCall(deps(), io(["read_file", "--path", `@${join(dir, "nope.txt")}`]).context)],
      ["a route argument missing", () => runCall(deps(), io(["read_thread"]).context)],
      ["staging with nowhere to stage", () => runCall(deps(), io(["rename_node", "--path", "A.md", "--new_name", "x".repeat(STAGE_ARGUMENTS_ABOVE + 1)]).context)],
      ["read with one word", () => runRead(deps(), io([], ["brain"]).context)],
      ["upload with three words", () => runUpload(deps(), io([], ["brain", "a.png", "extra"]).context)],
      ["upload --to with no value", () => runUpload(deps(), io([], ["brain", join(dir, "bad.json")], { to: true }).context)],
    ];
    for (const [what, run] of cases) {
      seen = [];
      expect(await run(), what).toBe(EXIT.usage);
      expect(apiRequests(), what).toEqual([]);
    }
  });
});

describe("the login, when there is no key or the key is refused", () => {
  const signedIn = () => {
    const asked = { count: 0 };
    const session = async (): Promise<SessionOutcome> => {
      asked.count++;
      return { kind: "ready", accessToken: TOKEN };
    };
    return { asked, session };
  };
  /** A fake /v1 that refuses the key and accepts the login, on every route. */
  const refuseTheKey = (route: string, body: unknown) => {
    handlers[route] = (req, res) =>
      req.headers.authorization === `Bearer ${TOKEN}` ? json(res, 200, body) : json(res, 401, { error: { code: "unauthenticated" } });
  };

  it("202-S1: an accepted key is sent, and the login is never asked for", async () => {
    const { asked, session } = signedIn();
    const { context } = io(["read_file", "--path", "TODO.md"]);
    handlers["GET /v1/file"] = (_req, res) => json(res, 200, { kind: "markdown", content: "x" });
    expect(await runCall(deps({ MDBRAIN_API_KEY: KEY }, "", session), context)).toBe(0);
    expect(asked.count).toBe(0);
    expect(seen.every((s) => s.headers.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it("202-S2: with no key, `read` sends the login's token and prints the answer", async () => {
    const { session } = signedIn();
    handlers["GET /v1/file"] = (_req, res) => json(res, 200, { kind: "markdown", content: "# from the login\n" });
    const { context, written, err } = io([], ["brain", "TODO.md"]);
    expect(await runRead(deps({ MDBRAIN_API_KEY: undefined }, "", session), context)).toBe(0);
    expect(written.join("")).toBe("# from the login\n");
    expect(err).toEqual([]);
    expect(seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it("202-S3: a key refused with 401 gives way to the login, says so once, and exits with the second answer's code", async () => {
    const { session } = signedIn();
    refuseTheKey("GET /v1/operations", { operations: CATALOGUE });
    refuseTheKey("GET /v1/file", { kind: "markdown", content: "x" });
    const { context, out, err } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: KEY }, "", session), context)).toBe(0);
    expect(JSON.parse(out.join("\n")).content).toBe("x");
    expect(err).toEqual(["The key in MDBRAIN_API_KEY was not accepted; using your mdbrain login instead."]);
    expect(seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it("202-S3: a key refused when there is no login to fall back on is the key's refusal, as before", async () => {
    handlers["GET /v1/operations"] = (_req, res) => json(res, 401, { error: { code: "unauthenticated" } });
    const { context, err } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps(), context)).toBe(EXIT.auth);
    expect(err.join("\n")).toContain("The key in MDBRAIN_API_KEY was not accepted: it is malformed");
    expect(seen).toHaveLength(1);
  });

  it("202-S4: a key that is limited or meets a 5xx does not try the login", async () => {
    for (const [status, code] of [
      [429, EXIT.limited],
      [503, EXIT.transport],
    ] as const) {
      const { asked, session } = signedIn();
      handlers["GET /v1/operations"] = (_req, res) => json(res, status, { error: { code: "x", message: "no" } }, { "retry-after": "3" });
      const { context } = io(["read_file", "--path", "TODO.md"]);
      expect(await runCall(deps({ MDBRAIN_API_KEY: KEY }, "", session), context)).toBe(code);
      expect(asked.count).toBe(0);
      expect(seen.every((s) => s.headers.authorization === `Bearer ${KEY}`)).toBe(true);
      seen = [];
    }
  });

  it("202-S5: with no key and no login, nothing is sent, it exits 3, and the sentence names both remedies", async () => {
    for (const run of [
      () => runCall(deps({ MDBRAIN_API_KEY: undefined }), io(["read_file", "--path", "A.md"]).context),
      () => runRead(deps({ MDBRAIN_API_KEY: undefined }), io([], ["brain", "A.md"]).context),
    ]) {
      expect(await run()).toBe(EXIT.auth);
    }
    const { context, err } = io(["read_file", "--path", "A.md"]);
    await runCall(deps({ MDBRAIN_API_KEY: undefined }), context);
    expect(err.join("\n")).toBe("No credential: set MDBRAIN_API_KEY to a member key, or run `mdbrain login`.");
    expect(seen).toEqual([]);
  });

  it("202-S5: a login whose refresh was refused says it has ended; one that could not be renewed is a transport failure", async () => {
    const ended = async (): Promise<SessionOutcome> => ({ kind: "stop", reason: "refreshed-away", message: "Your session has ended." });
    const unreachable = async (): Promise<SessionOutcome> => ({ kind: "stop", reason: "unreachable", message: "Could not renew; it has not ended." });
    const first = io(["read_file", "--path", "A.md"]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: undefined }, "", ended), first.context)).toBe(EXIT.auth);
    expect(first.err.join("\n")).toBe("Your session has ended.");
    const second = io(["read_file", "--path", "A.md"]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: undefined }, "", unreachable), second.context)).toBe(EXIT.transport);
    expect(second.err.join("\n")).toBe("Could not renew; it has not ended.");
    expect(seen).toEqual([]);
  });

  it("202-S6: with no key and an API address that is not this product's, the login is not sent and is not even read", async () => {
    const { asked, session } = signedIn();
    const { context, err } = io(["read_file", "--path", "A.md"]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: undefined, MDBRAIN_API_URL: "https://api.example.test/v1" }, "", session), context)).toBe(EXIT.auth);
    expect(err.join("\n")).toContain("so your login is not sent there");
    expect(asked.count).toBe(0);
    expect(seen).toEqual([]);
  });

  it("202-S6: a key refused at an address that is not this product's does not give way to the login", async () => {
    const { asked, session } = signedIn();
    refuseTheKey("GET /v1/operations", { operations: CATALOGUE });
    // The fake lives on loopback, where the login may go. So the command is
    // given a foreign address and its requests are carried to the fake beneath
    // it: the decision under test is the command's, on the address it was given.
    const foreign = "https://api.example.test/v1";
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      realFetch(String(input).replace(foreign, base), init)) as typeof fetch;
    try {
      const { context, err } = io(["read_file", "--path", "A.md"]);
      expect(await runCall(deps({ MDBRAIN_API_KEY: KEY, MDBRAIN_API_URL: foreign }, "", session), context)).toBe(EXIT.auth);
      expect(err.join("\n")).toContain("The key in MDBRAIN_API_KEY was not accepted: it is malformed");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(asked.count).toBe(0);
    expect(seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${KEY}`]);

    expect(loginMayGoTo(foreign)).toBe(false);
    expect(loginMayGoTo(API_URL)).toBe(true);
    expect(loginMayGoTo("http://127.0.0.1:4000/v1")).toBe(true);
    expect(loginMayGoTo("https://api.markdownbrain.ai.example.test/v1")).toBe(false);
  });

  it("202-S7: a login the API refuses names `mdbrain login`, not the key, and prints no token", async () => {
    const { session } = signedIn();
    handlers["GET /v1/operations"] = (_req, res) => json(res, 401, { error: { code: "unauthenticated" }, echoed: `Bearer ${TOKEN}` });
    const { context, out, err } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: undefined }, "", session), context)).toBe(EXIT.auth);
    expect(err.join("\n")).toBe("Your mdbrain login was not accepted. Run `mdbrain login` again.");
    expect([...out, ...err].join("\n")).not.toContain(TOKEN);
  });

  it("202-S7: a key that gave way to a login the API then refuses names the login", async () => {
    const { session } = signedIn();
    handlers["GET /v1/operations"] = (_req, res) => json(res, 401, { error: { code: "unauthenticated" } });
    const { context, err } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: KEY }, "", session), context)).toBe(EXIT.auth);
    expect(err).toEqual([
      "The key in MDBRAIN_API_KEY was not accepted; using your mdbrain login instead.",
      "Your mdbrain login was not accepted. Run `mdbrain login` again.",
    ]);
    expect(seen).toHaveLength(2);
  });

  it("202-S8: an invocation that reads the catalogue, stages its arguments and calls carries one credential throughout", async () => {
    const { session } = signedIn();
    refuseTheKey("GET /v1/operations", { operations: CATALOGUE });
    handlers["POST /v1/files"] = (_req, res) => json(res, 201, { file_id: "f-big" });
    const { context } = io(["create_file", "--workspace_id", "ws-1", "--path", "big.md", "--content", "x".repeat(STAGE_ARGUMENTS_ABOVE + 1)]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: KEY }, "", session), context)).toBe(0);
    const api = seen.filter((s) => s.url.startsWith("/v1/"));
    expect(api.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual(["GET /v1/operations", "GET /v1/operations", "POST /v1/uploads", "POST /v1/files"]);
    expect(api.slice(1).every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    // Storage gets the signed address and no credential of either kind.
    const storage = seen.filter((s) => s.url.startsWith("/storage/"));
    expect(storage.length).toBeGreaterThan(0);
    expect(storage.every((s) => s.headers.authorization === undefined)).toBe(true);
  });

  it("202-S8: a key the first answer accepted is never swapped for the login by a later 401", async () => {
    const { asked, session } = signedIn();
    handlers["GET /v1/file"] = (_req, res) => json(res, 401, { error: { code: "unauthenticated" } });
    const { context, err } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: KEY }, "", session), context)).toBe(EXIT.auth);
    expect(asked.count).toBe(0);
    expect(err.join("\n")).toContain("The key in MDBRAIN_API_KEY was not accepted: it is malformed");
    expect(seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
  });

  it("202-S8: a login renewed while an invocation runs is picked up by its next request", async () => {
    const tokens = [TOKEN, `${TOKEN}renewed`];
    let asked = 0;
    const session = async (): Promise<SessionOutcome> => ({ kind: "ready", accessToken: tokens[Math.min(asked++, 1)] });
    handlers["GET /v1/file"] = (_req, res) => json(res, 200, { kind: "markdown", content: "x" });
    const { context } = io(["read_file", "--path", "TODO.md"]);
    expect(await runCall(deps({ MDBRAIN_API_KEY: undefined }, "", session), context)).toBe(0);
    expect(seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}renewed`]);
  });

  it("202-S8: an upload given a workspace by name uses the login for the lookup, the staging and the commit", async () => {
    const { session } = signedIn();
    const file = join(dir, "s.png");
    writeFileSync(file, Buffer.from("tiny"));
    handlers["POST /v1/images"] = (_req, res) => json(res, 201, { file_id: "img" });
    const { context } = io([], ["brain", file]);
    expect(await runUpload(deps({ MDBRAIN_API_KEY: undefined }, "", session), context)).toBe(0);
    const api = seen.filter((s) => s.url.startsWith("/v1/"));
    expect(api.map((s) => s.url.split("?")[0])).toEqual(["/v1/workspaces", "/v1/uploads", "/v1/images"]);
    expect(api.every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("202-S9: nothing `call`, `read` or `upload` runs mints a key", () => {
    for (const file of ["../src/commands/call.ts", "../src/api/call.ts", "../src/api/http.ts", "../src/commands/session.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(/mint_member_key|mint_agent_key/);
    }
  });
});
