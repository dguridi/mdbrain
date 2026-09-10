import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  assetName,
  binaryName,
  channelRefusal,
  decideUpgrade,
  howToUpgrade,
  isCompiledExecPath,
  oldPathFor,
  publishedChecksum,
  replaceSteps,
  rollbackSteps,
  RUNNING_RUN_NOTICE,
  versionFromLocation,
} from "../src/upgrade/plan.ts";
import { downloadUrl, latestUrl, latestVersion } from "../src/upgrade/latest.ts";
import { sweepLeftover } from "../src/upgrade/sweep.ts";
import { LOOKUP_FAILED_MESSAGE, NOT_A_BINARY_MESSAGE, runUpgrade, STAGING_DIR, type UpgradeDeps } from "../src/commands/upgrade.ts";
import { CHANNEL, TARGET, VERSION } from "../src/version.ts";
import { COMMANDS } from "../src/main.ts";

const src = (name: string) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

// A published version that is always ahead of whatever this build reports, so a
// release bump does not silently turn every "an upgrade is available" case into
// "already on the latest tag" and take its assertions with it.
const NEWER = `${Number(VERSION.split(".")[0]) + 1}.0.0`;

const ARCHIVE = new Uint8Array([1, 2, 3, 4]);
// sha256 of the four bytes above, computed here rather than pasted.
const { createHash } = await import("node:crypto");
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");

const response = (init: { status?: number; headers?: Record<string, string>; body?: Uint8Array | string }) =>
  ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    arrayBuffer: async () => (init.body instanceof Uint8Array ? init.body.buffer : new TextEncoder().encode(String(init.body ?? "")).buffer),
    text: async () => (typeof init.body === "string" ? init.body : new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array())),
  }) as unknown as Response;

/** A world in which the latest release is `latest` and its bytes verify. */
function world(over: { latest?: string; platform?: NodeJS.Platform; sums?: string; bytes?: Uint8Array } = {}) {
  const latest = over.latest ?? NEWER;
  const asset = assetName(TARGET);
  const calls: Array<{ url: string; redirect: string | undefined }> = [];
  const moves: Array<[string, string]> = [];
  const written: string[] = [];
  const removed: string[] = [];
  const made: string[] = [];
  const deps: UpgradeDeps = {
    execPath: over.platform === "win32" ? "C:\\bin\\mdbrain.exe" : "/usr/local/bin/mdbrain",
    platform: over.platform ?? "linux",
    isCompiled: true,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), redirect: init?.redirect });
      if (String(url) === latestUrl()) return response({ status: 302, headers: { location: `https://github.com/x/y/releases/tag/v${latest}` } });
      if (String(url).endsWith("checksums.txt")) return response({ body: over.sums ?? `${ARCHIVE_SHA}  ${asset}\n` });
      return response({ body: over.bytes ?? ARCHIVE });
    }) as unknown as typeof fetch,
    writeBytes: async (path) => void written.push(path),
    renameFile: async (from, to) => void moves.push([from, to]),
    makeDir: async (path) => void made.push(path),
    removeDir: async (path) => void removed.push(path),
    extract: async (_archive, into, member) => join(into, member),
    makeExecutable: async () => {},
  };
  return { deps, calls, moves, written, removed, made, latest, asset };
}

const drive = async (deps: UpgradeDeps, flags: Record<string, string | boolean> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUpgrade(deps, { out: (l) => out.push(l), err: (l) => err.push(l), flags });
  return { code, out, err };
};

describe("upgrade: what it decides before it touches anything", () => {
  it("114-S1: a binary already on the latest tag says so and downloads nothing", async () => {
    const w = world({ latest: VERSION });
    const { code, out } = await drive(w.deps);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`mdbrain ${VERSION} is the latest version`);
    // The whole reason the lookup exists: without it this fetches 38.6 MB to
    // discover it has nothing to do.
    expect(w.calls.map((c) => c.url)).toEqual([latestUrl()]);
    expect(w.written).toEqual([]);
    expect(w.moves).toEqual([]);
  });

  it("114-S2: the artifact fetched is this binary's own target, and a mismatch replaces nothing", async () => {
    const good = world();
    const { code } = await drive(good.deps);
    expect(code).toBe(0);
    expect(good.calls.map((c) => c.url)).toContain(downloadUrl(NEWER, assetName(TARGET)));
    expect(good.calls.map((c) => c.url)).toContain(downloadUrl(NEWER, "checksums.txt"));

    const bad = world({ bytes: new Uint8Array([9, 9, 9]) });
    const failed = await drive(bad.deps);
    expect(failed.code).toBe(1);
    expect(failed.err.join("\n")).toContain("does not match its published checksum");
    expect(bad.written).toEqual([]);
    expect(bad.moves).toEqual([]);
  });

  it("114-S21: a download that answers badly is refused, and neither body is left holding a connection", async () => {
    const cancelled: string[] = [];
    const body = (name: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelled.push(name);
        },
      });

    // The artifact answers 404 and checksums.txt answers perfectly well, so its
    // body is the one nobody is going to read.
    const w = world();
    const asset = assetName(TARGET);
    w.deps.fetch = (async (url: string) => {
      const at = String(url);
      if (at === latestUrl()) {
        return new Response(null, { status: 302, headers: { location: "https://github.com/x/y/releases/tag/v0.2.0" } });
      }
      if (at.endsWith("checksums.txt")) return new Response(body("checksums"), { status: 200 });
      return new Response(body("artifact"), { status: 404 });
    }) as unknown as typeof fetch;

    const { code, err } = await drive(w.deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("The download failed and nothing was changed");
    expect(err.join("\n")).toContain("404");
    expect(w.moves).toEqual([]);
    expect(w.written).toEqual([]);
    // Both of them, and the second is the one that matters: a body nobody reads
    // keeps its socket, and this program drains the loop rather than exiting, so
    // that is the prompt not coming back long after the error was printed.
    expect(cancelled.sort()).toEqual(["artifact", "checksums"]);

    // The mirror: checksums.txt is what fails, and the artifact is the 38 MB
    // nobody will now read.
    const other: string[] = [];
    const mirrorBody = (name: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          other.push(name);
        },
      });
    const m = world();
    m.deps.fetch = (async (url: string) => {
      const at = String(url);
      if (at === latestUrl()) {
        return new Response(null, { status: 302, headers: { location: "https://github.com/x/y/releases/tag/v0.2.0" } });
      }
      if (at.endsWith("checksums.txt")) return new Response(mirrorBody("checksums"), { status: 500 });
      return new Response(mirrorBody("artifact"), { status: 200 });
    }) as unknown as typeof fetch;

    const mirror = await drive(m.deps);
    expect(mirror.code).toBe(1);
    expect(mirror.err.join("\n")).toContain("checksums.txt answered 500");
    expect(other.sort()).toEqual(["artifact", "checksums"]);
    expect(asset).toBe(assetName(TARGET));
  });

  it("114-S2: an asset checksums.txt does not mention is a refusal, not a pass", async () => {
    const w = world({ sums: `${ARCHIVE_SHA}  mdbrain-some-other-target.tar.gz\n` });
    const { code, err } = await drive(w.deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("does not mention");
    expect(w.moves).toEqual([]);
  });

  it("114-S2: the name is matched whole, so one target's line cannot verify another's", () => {
    // `mdbrain-linux-x64` is a prefix of `mdbrain-linux-x64-musl`, and the musl
    // line sorts first in `sha256sum`'s own output — so a match that were
    // anything looser than the whole name is the one pair where being wrong is
    // silent: the download verifies, replaces, and then does not run.
    const musl = `bb${"0".repeat(62)}  mdbrain-linux-x64-musl.tar.gz`;
    const glibc = `aa${"0".repeat(62)}  mdbrain-linux-x64.tar.gz`;
    const text = `${musl}\n${glibc}\n`;
    expect(publishedChecksum(text, "mdbrain-linux-x64.tar.gz")).toBe(`aa${"0".repeat(62)}`);
    expect(publishedChecksum(text, "mdbrain-linux-x64-musl.tar.gz")).toBe(`bb${"0".repeat(62)}`);
    // The witnesses that a substring or prefix match would fail: a name that is
    // a piece of two of them, and one the file does not carry at all.
    expect(publishedChecksum(text, "mdbrain-linux-x64")).toBeNull();
    expect(publishedChecksum(text, "mdbrain-windows-x64.tar.gz")).toBeNull();
  });

  it("114-S6: a channel this command did not place is refused, and names the command that owns it", async () => {
    expect(channelRefusal("direct")).toBeNull();
    expect(channelRefusal("homebrew")).toContain("brew upgrade mdbrain");
    expect(channelRefusal("scoop")).toContain("scoop update mdbrain");
    expect(decideUpgrade("homebrew", "0.1.0", "0.2.0")).toMatchObject({ kind: "refused" });
    // The shipped constant is the direct one, or every install refuses itself.
    expect(CHANNEL).toBe("direct");
  });

  it("114-S7: the lookup does not follow the redirect, and reads the tag off Location", async () => {
    const w = world();
    await drive(w.deps, { check: true });
    const lookup = w.calls.find((c) => c.url === latestUrl());
    // Asserted on the request: a lookup that followed the redirect still returns
    // the right answer while silently costing the body and the rate limit, so
    // nothing about the result would show this being removed.
    expect(lookup?.redirect).toBe("manual");

    expect(versionFromLocation("https://github.com/x/y/releases/tag/v1.2.3")).toBe("1.2.3");
    expect(versionFromLocation("https://github.com/x/y/releases/tag/1.2.3")).toBe("1.2.3");
    // A repository with no release redirects to the releases page itself, whose
    // last segment would otherwise be offered as a version.
    expect(versionFromLocation("https://github.com/x/y/releases")).toBeNull();
    expect(versionFromLocation(null)).toBeNull();
  });

  it("114-S7: a lookup that cannot be made stops the command and says so", async () => {
    const deps = world().deps;
    deps.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await latestVersion(deps.fetch)).toBeNull();
    const { code, err } = await drive(deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toBe(LOOKUP_FAILED_MESSAGE);
  });

  it("114-S1: --check reports and replaces nothing", async () => {
    const w = world();
    const { code, out } = await drive(w.deps, { check: true });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`${NEWER} is available`);
    expect(w.moves).toEqual([]);
    expect(w.written).toEqual([]);
  });

  it("114-S1: --check from a binary already on the latest tag says so, and offers nothing", async () => {
    // The sibling of the case above, and it has its own door: `--check`
    // answers before `decideUpgrade` is ever reached, so the branch that
    // recognises being current is a second home for that rule and nothing
    // else drove it. The sentence is what carries this — the lookup is made
    // and nothing is downloaded either way, so a check on the calls alone
    // stays green while somebody on the newest release is told to upgrade to
    // the version they are already running.
    const w = world({ latest: VERSION });
    const { code, out } = await drive(w.deps, { check: true });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`mdbrain ${VERSION} is the latest version`);
    expect(out.join("\n")).not.toContain("is available");
    expect(w.calls.map((c) => c.url)).toEqual([latestUrl()]);
    expect(w.moves).toEqual([]);
    expect(w.written).toEqual([]);
  });

  it("refuses from a source checkout, where there is no binary to replace", async () => {
    const deps = world().deps;
    deps.isCompiled = false;
    const { code, err } = await drive(deps);
    expect(code).toBe(1);
    expect(err.join("\n")).toBe(NOT_A_BINARY_MESSAGE);
  });

  it("114-S1: --check from a checkout does not advise a command that would refuse", async () => {
    const deps = world().deps;
    deps.isCompiled = false;
    const { code, out } = await drive(deps, { check: true });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`${NEWER} is available`);
    expect(out.join("\n")).toContain("git");
    expect(out.join("\n")).not.toContain("Run `mdbrain upgrade` to replace it.");
  });

  it("114-S19: --check answers from an install this command may not replace", () => {
    // The refusal is `upgrade`'s, not the question's: withholding what is
    // published from a Homebrew install answers a question nobody asked.
    expect(howToUpgrade("homebrew", true)).toContain("brew upgrade mdbrain");
    expect(howToUpgrade("scoop", true)).toContain("scoop update mdbrain");
    expect(howToUpgrade("direct", true)).toContain("mdbrain upgrade");
    expect(howToUpgrade("direct", false)).toContain("git");
  });

  it("114-S19: an interpreter under any of its usual names is not a binary to replace", () => {
    // A name this does not recognise reads as compiled, so the miss is not a
    // refused upgrade — it is a download renamed over the machine's node.
    for (const path of ["/usr/bin/node", "/usr/bin/nodejs", "/usr/bin/node22", "/opt/bun-1.2/bun", "C:\\Program Files\\nodejs\\node.exe"]) {
      expect(isCompiledExecPath(path), path).toBe(false);
    }
    for (const path of ["/usr/local/bin/mdbrain", "C:\\bin\\mdbrain.exe", "/home/me/mdbrain-0.2.0"]) {
      expect(isCompiledExecPath(path), path).toBe(true);
    }
  });

  it("114-S19: and the interpreter names are written down in exactly one place", () => {
    // The predicate above is pure and easy to assert; the line that decides what
    // a real `mdbrain` acts on is `defaultUpgradeDeps`, which no test drives.
    // Putting the earlier `node|bun` regex back there leaves every case in this
    // app green while a download renames itself over the machine's `nodejs`, so
    // what is pinned here is the structural half the pure case cannot reach:
    // this test exists in the source and nowhere else.
    const files = ["upgrade/plan.ts", "upgrade/sweep.ts", "commands/upgrade.ts", "main.ts"];
    const definitions = files.flatMap((f) => src(f).split("\n").filter((line) => /\(node\b.*\bbun\)/.test(line)));
    expect(definitions).toHaveLength(1);
    expect(src("upgrade/plan.ts")).toContain(definitions[0].trim());
    // And the two consumers reach it by name rather than by a second copy.
    expect(src("commands/upgrade.ts")).toContain("isCompiled: isCompiledExecPath(process.execPath)");
    expect(src("upgrade/sweep.ts")).toContain("!isCompiledExecPath(execPath)");
  });
});

describe("upgrade: the replace, per platform", () => {
  it("114-S3: POSIX stages beside the binary, not in /tmp, and renames over the target", async () => {
    const w = world({ platform: "linux" });
    const { code } = await drive(w.deps);
    expect(code).toBe(0);
    const installDir = dirname(w.deps.execPath);
    // A rename is only cheap and atomic within a volume, so staging in the temp
    // directory turns the last step into a cross-volume move.
    expect(w.made).toEqual([join(installDir, STAGING_DIR)]);
    expect(dirname(w.written[0])).toBe(join(installDir, STAGING_DIR));
    expect(w.written[0].startsWith(tmpdir())).toBe(false);
    // And the extraction lands somewhere that is NOT the running binary's own
    // path: the archive holds the binary under its own name, so extracting into
    // the install directory itself would write straight over what is running.
    expect(w.moves).toHaveLength(1);
    expect(w.moves[0][0]).not.toBe(w.deps.execPath);
    expect(w.moves[0][1]).toBe(w.deps.execPath);
    expect(replaceSteps("linux", "/b/mdbrain", "/b/staged")).toEqual([
      { kind: "rename", from: "/b/staged", to: "/b/mdbrain", because: expect.any(String) },
    ]);
  });

  it("114-S3: the staging directory goes whether the replace worked or not", async () => {
    const ok = world({ platform: "linux" });
    await drive(ok.deps);
    expect(ok.removed).toEqual([join(dirname(ok.deps.execPath), STAGING_DIR)]);

    const broken = world({ platform: "linux" });
    broken.deps.renameFile = async () => {
      throw new Error("EACCES");
    };
    const failed = await drive(broken.deps);
    expect(failed.code).toBe(1);
    expect(broken.removed).toEqual([join(dirname(broken.deps.execPath), STAGING_DIR)]);
  });

  it("114-S4: Windows renames the running exe out of the way FIRST, then moves the new one in", () => {
    const steps = replaceSteps("win32", "C:\\bin\\mdbrain.exe", "C:\\bin\\staged.exe");
    // Two steps in this order. One step is the POSIX shape and it fails here: a
    // rename onto an occupied path is a delete of that path, and Windows will
    // not delete a running image.
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ from: "C:\\bin\\mdbrain.exe", to: "C:\\bin\\mdbrain.exe.old" });
    expect(steps[1]).toMatchObject({ from: "C:\\bin\\staged.exe", to: "C:\\bin\\mdbrain.exe" });
  });

  it("114-S4: and the command actually performs them in that order", async () => {
    const w = world({ platform: "win32" });
    const { code } = await drive(w.deps);
    expect(code).toBe(0);
    expect(w.moves).toHaveLength(2);
    expect(w.moves[0]).toEqual(["C:\\bin\\mdbrain.exe", "C:\\bin\\mdbrain.exe.old"]);
    expect(w.moves[1][1]).toBe("C:\\bin\\mdbrain.exe");
    expect(w.moves[1][0]).toContain(STAGING_DIR);
  });

  it("114-S17: a Windows replace that fails on its second step puts the first one back", async () => {
    const w = world({ platform: "win32" });
    // A model filesystem, because the failure this asserts against is a state on
    // disk rather than a call: the wrong build reports failure just as loudly and
    // leaves nothing at `execPath`.
    const disk = new Set([w.deps.execPath]);
    let attempts = 0;
    w.deps.renameFile = async (from, to) => {
      attempts += 1;
      // The way a freshly extracted .exe held open by a virus scanner fails.
      if (attempts === 2) throw new Error("EPERM: operation not permitted, rename");
      if (!disk.delete(from)) throw new Error(`ENOENT: ${from}`);
      disk.add(to);
    };
    const { code, err } = await drive(w.deps);
    expect(code).toBe(1);
    expect(attempts).toBe(3);
    expect([...disk]).toEqual([w.deps.execPath]);
    expect(err.join("\n")).toContain(`put back at ${w.deps.execPath}`);

    // The undo is the reverse rename, and it is a value so it can be read here.
    expect(rollbackSteps(replaceSteps("win32", "C:\\bin\\mdbrain.exe", "C:\\bin\\staged.exe").slice(0, 1))).toEqual([
      { kind: "rename", from: "C:\\bin\\mdbrain.exe.old", to: "C:\\bin\\mdbrain.exe", because: expect.any(String) },
    ]);
  });

  it("114-S17: and where the first step is the one that failed, nothing is put back", async () => {
    // The POSIX control, and the reason this is a per-platform finding: one step
    // that fails has moved nothing, so a rollback there would be inventing work.
    const w = world({ platform: "linux" });
    w.deps.renameFile = async () => {
      throw new Error("EACCES");
    };
    const { code, err } = await drive(w.deps);
    expect(code).toBe(1);
    expect(rollbackSteps([])).toEqual([]);
    expect(err.join("\n")).toContain("Nothing was moved");
  });

  it("114-S18: and when putting it back fails too, the sentence names the file to rename", async () => {
    const w = world({ platform: "win32" });
    const disk = new Set([w.deps.execPath]);
    let attempts = 0;
    w.deps.renameFile = async (from, to) => {
      attempts += 1;
      if (attempts >= 2) throw new Error("EPERM: operation not permitted, rename");
      disk.delete(from);
      disk.add(to);
    };
    const { code, err } = await drive(w.deps);
    expect(code).toBe(1);
    // The one fact somebody with nothing on their PATH needs: where the working
    // binary actually is, and what to rename it to. The second half is asserted
    // with the verb attached, because `<execPath>.old` contains `execPath` — a
    // bare `toContain(execPath)` is satisfied by the first half alone and would
    // stay green with the rename target dropped from the sentence entirely.
    expect([...disk]).toEqual([oldPathFor(w.deps.execPath)]);
    expect(err.join("\n")).toContain(oldPathFor(w.deps.execPath));
    expect(err.join("\n")).toContain(`renaming it to ${w.deps.execPath}`);
  });

  it("114-S12: it says a running run keeps the old version, on every platform", async () => {
    for (const platform of ["linux", "darwin", "win32"] as NodeJS.Platform[]) {
      const { out } = await drive(world({ platform }).deps);
      // Unconditional: a sentence that appeared on one platform only would read
      // as "no run is up" rather than as "this platform cannot tell".
      expect(out, platform).toContain(RUNNING_RUN_NOTICE);
    }
  });

  it("names the archive member the platform actually ships", () => {
    expect(binaryName("win32")).toBe("mdbrain.exe");
    expect(binaryName("linux")).toBe("mdbrain");
    expect(binaryName("darwin")).toBe("mdbrain");
    expect(assetName("linux-x64-musl")).toBe("mdbrain-linux-x64-musl.tar.gz");
  });
});

describe("upgrade: the leftover", () => {
  it("114-S5: every invocation attempts the delete and ignores failure", async () => {
    const asked: string[] = [];
    await sweepLeftover("C:\\bin\\mdbrain.exe", "win32", async (p) => {
      asked.push(p);
    });
    expect(asked).toEqual(["C:\\bin\\mdbrain.exe.old"]);

    // Failure is the expected outcome while the old process is alive, so it
    // reaches neither the person nor the exit code.
    await expect(
      sweepLeftover("C:\\bin\\mdbrain.exe", "win32", async () => {
        throw new Error("EPERM");
      }),
    ).resolves.toBeUndefined();
  });

  it("114-S19: it only deletes where this program could have made one", async () => {
    const asked: string[] = [];
    const watch = async (p: string) => void asked.push(p);
    // Nothing displaces a binary on POSIX, so an `<execPath>.old` there is a
    // file somebody else made — and from a source checkout `execPath` is the
    // interpreter, so the path aimed at is the machine's own node.
    await sweepLeftover("/usr/local/bin/mdbrain", "linux", watch);
    await sweepLeftover("/usr/bin/node", "win32", watch);
    await sweepLeftover("C:\\Program Files\\nodejs\\node.exe", "win32", watch);
    expect(asked).toEqual([]);
  });

  it("114-S5: it is in the binary and runs for any command, not only for upgrade", () => {
    const main = src("main.ts");
    expect(main).toContain("sweepLeftover(process.execPath, process.platform)");
    // Inside `run`, which every invocation goes through — an installer-only or
    // upgrade-only sweep leaves one behind for every upgrade the script did not
    // perform, which is every upgrade this command performs.
    const inRun = main.slice(main.indexOf("export function run(argv"));
    expect(inRun.slice(0, inRun.indexOf("dispatch("))).toContain("sweepLeftover");
    expect(oldPathFor("C:\\bin\\mdbrain.exe")).toBe("C:\\bin\\mdbrain.exe.old");
  });
});

describe("upgrade: how it is registered", () => {
  it("is one of the commands, so --help names it and the dispatcher reaches it", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain("upgrade");
    const spec = COMMANDS.find((c) => c.name === "upgrade")!;
    expect(spec.flags?.map((f) => f.name)).toEqual(["check"]);
  });

  it("the target is baked in rather than detected", () => {
    // Detection has exactly one way to be silently wrong — a musl machine handed
    // the glibc build, which downloads, verifies, replaces and does not run.
    expect(TARGET).toMatch(/^(windows|darwin|linux)-(x64|arm64)(-musl)?$/);
    const version = src("version.ts");
    expect(version).not.toMatch(/process\.(platform|arch)/);
  });
});

describe("upgrade: what the release build rewrites", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../../../.github/workflows/release.yml", import.meta.url)), "utf8");

  it("the release rewrites the target line, and the line it rewrites is the one that ships", () => {
    // Two files that have to agree about one line's shape, in two languages,
    // where a disagreement is silent: the sed matches nothing, every artifact
    // ships the development default, and every musl and darwin machine is then
    // offered the linux-x64 build by a binary that verified it correctly.
    const sed = workflow.split("\n").find((line) => line.includes("sed -i") && line.includes("TARGET"));
    expect(sed).toBeDefined();
    const pattern = /s\|\^([^|]+)\|/.exec(sed!)?.[1];
    expect(pattern).toBeDefined();
    const shipped = src("version.ts").split(/\r?\n/).filter((line) => new RegExp(`^${pattern!.replace(/\.\*$/, "")}`).test(line));
    expect(shipped).toHaveLength(1);

    // And it puts the tree back AFTER the loop, not inside it. A presence can
    // only see the restore deleted or renamed; the way this breaks is somebody
    // tidying it up next to the `sed` it undoes, and then every one of the seven
    // artifacts compiles with the development default while the sed, the
    // restore and this file all still say the right things.
    const restore = workflow.indexOf("git checkout -- src/version.ts");
    const build = workflow.indexOf("bun build --compile");
    const loopEnd = workflow.indexOf("\n          done", build);
    expect(restore).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(loopEnd);
  });

  it("every target the release builds is one this binary could ask for", () => {
    const loop = workflow.slice(workflow.indexOf("for t in "), workflow.indexOf("; do", workflow.indexOf("for t in ")));
    const targets = loop.replace("for t in ", "").split(/[^A-Za-z0-9-]+/).filter(Boolean);
    expect(targets.length).toBeGreaterThan(1);
    for (const target of targets) {
      expect(assetName(target), target).toBe(`mdbrain-${target}.tar.gz`);
    }
    expect(targets).toContain(TARGET);
  });
});
