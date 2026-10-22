// The HTTP API's wire, and Storage's: the impure half of `call`, `read` and
// `upload`.
//
// Two kinds of request leave from here. Calls to the API carry the member key
// and nothing else of this program's; bytes for a staged upload go straight to
// Storage at the signed address `begin_upload` handed back, carrying no key at
// all, because the address is the permission. Every failure is sorted into one
// of three errors here so the commands can map it to an exit code without
// reading a message: an answer that never arrived (or arrived only in part),
// Storage refusing the bytes, or the local file the bytes come from failing.

import { open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { RESUMABLE_ABOVE } from "./call.ts";

/** One answer from the API, read whole. */
export interface ApiAnswer {
  status: number;
  /** `Retry-After`, when the answer carried one. */
  retryAfter: string | null;
  /** Whether the body was JSON, which decides how it is printed. */
  isJson: boolean;
  text: string;
  /** The body parsed, when it was JSON. */
  body: unknown;
}

/** No usable answer: the network failed, the answer stopped mid-body, the
 *  request ran out of time, or the address redirected. */
export class TransportError extends Error {}

/** Storage refused the bytes of a staged upload, with its status. */
export class StorageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The local file a staged upload reads could not be read, or changed while it
 *  was being sent. A fault of the invocation's input, not of the network or the
 *  server. */
export class LocalFileError extends Error {}

/**
 * How long a request may take before it is given up as never answered.
 *
 * Every request carries a deadline because a connection that goes silent —
 * a proxy holding it open, a laptop that slept — would otherwise leave a script
 * waiting forever on a command that will never finish. A Storage request's
 * deadline grows with the bytes it carries, at a floor speed below any link
 * worth uploading over, so a large chunk on a slow line is not cut off while a
 * stalled one still is. They are constants rather than settings, like every
 * other deadline in this program; the object is exported so a test can shorten
 * them rather than wait a minute.
 */
export const TIMEOUTS = {
  /** One API call, answer and body together. */
  apiMs: 60_000,
  /** One Storage request, before the time its bytes add. */
  storageMs: 60_000,
  /** The floor upload speed a Storage deadline allows for: 50 KB/s. */
  storageBytesPerMs: 50,
};

/** The deadline for a Storage request that sends `bytes`. */
function storageDeadline(bytes: number): number {
  return TIMEOUTS.storageMs + Math.ceil(bytes / TIMEOUTS.storageBytesPerMs);
}

/** The bytes a staged upload sends, read a range at a time so a large file is
 *  never held whole when it goes in chunks. */
export interface ByteSource {
  size: number;
  /** Exactly `length` bytes from `offset`, or a rejection: a source that has
   *  fewer than it declared has changed, and is never read short. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A source over bytes already in memory. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.byteLength, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}

/**
 * A source over a file on disk, opened for each read.
 *
 * **Opened for each read rather than held for the upload**, because Windows
 * refuses to rename a file over one that is open: an editor saving the file
 * mid-upload would fail for as long as the upload lasted. Opened per read, the
 * save goes through, and the upload is the one refused.
 *
 * **A file that changes while it is sent is refused, not sent.** Its size was
 * declared to `begin_upload` before the first byte went, so a file that shrank
 * can only produce an upload that never completes, one that grew would arrive
 * cut at its old size, and one rewritten or replaced between chunks would arrive
 * torn from two versions — the last two with exit 0. So every read checks,
 * after reading, that the file it read still has the size, modification time and
 * change time the caller measured: a change before or during a read is caught by
 * that read, and one after the last read is too late to matter, since every byte
 * sent was read before it. The change time is the one no tool can put back, so it
 * catches a copy that keeps the old modification time (`cp -p`, `rsync -t`) over
 * a file of the same size. A same-size rewrite inside one tick of a coarse
 * filesystem clock (FAT's two seconds) leaves all three unchanged and cannot be
 * seen this way.
 *
 * @param path the file
 * @param measured its `stat`, already taken by the caller, which declared the
 *   size to `begin_upload`
 * @throws LocalFileError when the file cannot be opened or read, comes up short,
 *   or has changed since it was measured
 */
export function fileSource(path: string, measured: Pick<Stats, "size" | "mtimeMs" | "ctimeMs">): ByteSource {
  const size = measured.size;
  return {
    size,
    async read(offset, length) {
      let handle: FileHandle;
      try {
        handle = await open(path, "r");
      } catch (cause) {
        throw new LocalFileError(`Could not read ${path}: ${errnoOf(cause)}`);
      }
      try {
        const buffer = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        if (filled < length) {
          throw new LocalFileError(`${path} changed while it was being sent: it was ${size} bytes, and now ends at byte ${offset + filled}.`);
        }
        const now = await handle.stat();
        if (now.size !== size || now.mtimeMs !== measured.mtimeMs || now.ctimeMs !== measured.ctimeMs) {
          const how = now.size !== size ? `it was ${size} bytes, and is now ${now.size}` : "it was written to, at the same size";
          throw new LocalFileError(`${path} changed while it was being sent (${how}); nothing was committed. Upload it again once it has stopped changing.`);
        }
        return buffer;
      } catch (cause) {
        if (cause instanceof LocalFileError) throw cause;
        throw new LocalFileError(`Could not read ${path}: ${errnoOf(cause)}`);
      } finally {
        await handle.close();
      }
    },
  };
}

/** A filesystem error as a short reason: its code, or its message. */
function errnoOf(cause: unknown): string {
  return (cause as NodeJS.ErrnoException).code ?? (cause as Error).message;
}

/** What `begin_upload` answers, as far as sending the bytes needs it. */
export interface BegunUpload {
  upload_id: string;
  url: string;
  resumable?: {
    endpoint: string;
    headers: Record<string, string>;
    bucket: string;
    object_name: string;
  };
}

/** The reason a `fetch` or a body read failed. Node hides the network's reason
 *  in `cause`, and a deadline surfaces as a `TimeoutError` named nowhere else. */
function fetchFailure(cause: unknown, deadlineMs: number): string {
  const error = cause as Error & { cause?: { message?: string; code?: string } };
  if (error.name === "TimeoutError") return `no answer within ${Math.round(deadlineMs / 1000)} s`;
  const inner = error.cause?.code ?? error.cause?.message;
  return inner ? `${error.message} (${inner})` : error.message;
}

/** A body `fetch` accepts. A view over part of a larger buffer is copied out;
 *  one that spans its whole buffer is sent as it is, so a large staged object
 *  is not copied again on its way out. */
function body(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer as ArrayBuffer;
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Calls the API.
 *
 * **A redirect is not followed.** One that crosses origins drops the
 * `Authorization` header, so the request would arrive without its key and be
 * refused as though the key were bad; reporting the address instead says what
 * actually went wrong.
 *
 * @param base the API's address, ending in `/v1`
 * @param key the member key
 * @param method the HTTP method
 * @param path the route under `/v1`, with any query string
 * @param options a JSON body, or extra headers
 * @throws TransportError when no whole answer arrives within the deadline
 */
export async function callApi(
  base: string,
  key: string,
  method: string,
  path: string,
  options: { json?: string; headers?: Record<string, string> } = {},
): Promise<ApiAnswer> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json", ...options.headers };
  if (options.json !== undefined) headers["Content-Type"] = "application/json";
  // One signal for the request and its body, so an answer whose headers came
  // quickly but whose body stalls is still given up.
  const deadline = TIMEOUTS.apiMs;
  const signal = AbortSignal.timeout(deadline);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.json !== undefined ? { body: options.json } : {}),
      redirect: "manual",
      signal,
    });
  } catch (cause) {
    throw new TransportError(`Could not reach ${base}: ${fetchFailure(cause, deadline)}`);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new TransportError(
      `${base}${path.split("?")[0]} redirected to ${res.headers.get("location") ?? "somewhere else"}; a redirect would drop the key, so the address is wrong.`,
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    throw new TransportError(`${base} answered HTTP ${res.status} but the answer was cut off: ${fetchFailure(cause, deadline)}`);
  }
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  let parsed: unknown = undefined;
  if (isJson) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return { status: res.status, retryAfter: res.headers.get("retry-after"), isJson: parsed !== undefined, text, body: parsed };
}

/**
 * A Storage answer that is not a success, as the error the command reports.
 *
 * Its body is read only to quote it, so a body that fails to arrive costs the
 * quote and nothing else: the status already says Storage refused.
 */
async function storageRefusal(res: Response, what: string): Promise<StorageError> {
  const text = await res.text().catch(() => "");
  const said = text.replace(/\s+/g, " ").trim().slice(0, 300);
  return new StorageError(res.status, `Storage refused ${what} (HTTP ${res.status})${said ? `: ${said}` : ""}`);
}

/**
 * Sends a staged upload's bytes to Storage: in one `PUT` to the signed address,
 * or over the resumable protocol when the object is large and the upload offers
 * it.
 *
 * @throws StorageError when Storage refuses, TransportError when it cannot be
 *   reached or does not answer in time, LocalFileError when the source fails
 */
export async function sendStaged(begun: BegunUpload, source: ByteSource, contentType: string): Promise<void> {
  if (source.size > RESUMABLE_ABOVE && begun.resumable) {
    await sendResumable(begun.resumable, source, contentType);
    return;
  }
  const bytes = await source.read(0, source.size);
  const deadline = storageDeadline(bytes.byteLength);
  let res: Response;
  try {
    res = await fetch(begun.url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: body(bytes),
      signal: AbortSignal.timeout(deadline),
    });
  } catch (cause) {
    throw new TransportError(`Could not reach Storage: ${fetchFailure(cause, deadline)}`);
  }
  if (!res.ok) throw await storageRefusal(res, "the upload");
  await res.body?.cancel().catch(() => undefined);
}

/**
 * An `Upload-Offset` header as a byte count, or null when there is none to read.
 *
 * Read with care because `Number(null)` is `0`: an answer without the header
 * would otherwise say Storage holds nothing, and a half-sent upload would start
 * again from the first byte.
 */
export function uploadOffset(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  return Number(header.trim());
}

/** The TUS protocol version Storage's resumable endpoint speaks. */
const TUS_VERSION = "1.0.0";

/** How many rounds in a row may end without Storage holding more of the upload
 *  than it ever has, before the upload gives up. */
const STALLED_ROUNDS = 3;

/** `Upload-Metadata`: comma-separated pairs, each value base64. */
function tusMetadata(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `${name} ${Buffer.from(value, "utf8").toString("base64")}`)
    .join(",");
}

/**
 * The resumable (TUS) protocol, as much of it as one upload needs: create the
 * upload, then send it chunk by chunk, each at the offset the server holds.
 *
 * A chunk that fails is not resent blindly: the server is asked how much it
 * kept (`HEAD`, `Upload-Offset`) and the upload carries on from there, which is
 * what makes a dropped connection cost one chunk rather than the whole file.
 * Every request carries the signature `begin_upload` issued, which is what
 * authorises it; no key of this program's goes to Storage.
 *
 * **The loop is bounded by progress, not by failures.** A round counts as
 * progress only when the upload reaches further than it ever has; a server that
 * accepts a chunk and then reports holding less, round after round, would
 * otherwise reset a failure count forever and never let the command end.
 */
async function sendResumable(
  resumable: NonNullable<BegunUpload["resumable"]>,
  source: ByteSource,
  contentType: string,
): Promise<void> {
  const common = { ...resumable.headers, "Tus-Resumable": TUS_VERSION };
  let created: Response;
  try {
    created = await fetch(resumable.endpoint, {
      method: "POST",
      headers: {
        ...common,
        "Upload-Length": String(source.size),
        "Upload-Metadata": tusMetadata({
          bucketName: resumable.bucket,
          objectName: resumable.object_name,
          contentType,
          cacheControl: "3600",
        }),
      },
      signal: AbortSignal.timeout(TIMEOUTS.storageMs),
    });
  } catch (cause) {
    throw new TransportError(`Could not reach Storage: ${fetchFailure(cause, TIMEOUTS.storageMs)}`);
  }
  if (created.status !== 201) throw await storageRefusal(created, "the resumable upload");
  await created.body?.cancel().catch(() => undefined);
  const location = created.headers.get("location");
  if (!location) throw new StorageError(created.status, "Storage created the resumable upload but did not say where it is");
  const target = new URL(location, resumable.endpoint).toString();

  let offset = 0;
  let furthest = 0;
  let stalled = 0;
  let lastFailure: StorageError | TransportError | null = null;
  while (offset < source.size) {
    const chunk = await source.read(offset, Math.min(RESUMABLE_ABOVE, source.size - offset));
    const deadline = storageDeadline(chunk.byteLength);
    let res: Response | null = null;
    let failure: StorageError | TransportError | null = null;
    try {
      res = await fetch(target, {
        method: "PATCH",
        headers: { ...common, "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
        body: body(chunk),
        signal: AbortSignal.timeout(deadline),
      });
    } catch (cause) {
      failure = new TransportError(`Lost Storage mid-upload: ${fetchFailure(cause, deadline)}`);
    }
    if (res && res.status === 204) {
      await res.body?.cancel().catch(() => undefined);
      const said = uploadOffset(res.headers.get("upload-offset"));
      offset = said !== null && said > offset ? said : offset + chunk.byteLength;
    } else {
      if (res) {
        // A 4xx other than a conflict over the offset is a refusal, and asking
        // again would only be refused again.
        if (res.status >= 400 && res.status < 500 && res.status !== 409) throw await storageRefusal(res, "a chunk");
        failure = await storageRefusal(res, "a chunk");
      }
      lastFailure = failure;
      offset = await heldOffset(target, common, offset);
    }
    if (offset > furthest) {
      furthest = offset;
      stalled = 0;
    } else if (++stalled >= STALLED_ROUNDS) {
      throw (
        lastFailure ??
        new TransportError(`Storage made no progress on the upload in ${STALLED_ROUNDS} rounds; it holds ${offset} of ${source.size} bytes.`)
      );
    }
  }
}

/** How many bytes Storage holds of a resumable upload, or the caller's own
 *  count when it cannot say. */
async function heldOffset(target: string, headers: Record<string, string>, fallback: number): Promise<number> {
  try {
    const res = await fetch(target, { method: "HEAD", headers, signal: AbortSignal.timeout(TIMEOUTS.storageMs) });
    const said = uploadOffset(res.headers.get("upload-offset"));
    return res.ok && said !== null ? said : fallback;
  } catch {
    return fallback;
  }
}
