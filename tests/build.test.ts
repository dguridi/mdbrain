import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repoRoot = join(appRoot, "..", "..");

// The `bun build --compile` invocations, isolated from whatever else shares a
// line or a script with them. A scan that something other than the command could
// satisfy reads as a pass while the command it claims to cover says something
// else, and there are two ways for that to happen here. A comment: release.yml
// carries a long one directly above the line under test. And a neighbouring
// shell clause: a build script is one string, so a `--production` in a prefix
// step is not a flag the compiler is handed. Both files go through this, because
// a rule enforced on one of the two commands is not a rule.
function compileCommands(text: string): string[] {
  return text
    .replace(/\\\r?\n\s*/g, " ") // a command continued across lines is one command
    .split(/\r?\n|&&|\|\||;/)
    .map((clause) => clause.replace(/(^|\s)#.*$/, ""))
    .filter((clause) => clause.includes("bun build --compile"));
}

describe("the released binary is compiled in production mode", () => {
  it("123-S1: both build commands pass --production", () => {
    const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const local = compileCommands(manifest.scripts.build);
    expect(local).toHaveLength(1);
    expect(local[0]).toContain("--production");

    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
    const released = compileCommands(workflow);
    // One command for all seven targets, in a loop — two would mean a target
    // could be built one way and the rest another.
    expect(released).toHaveLength(1);
    expect(released[0]).toContain("--production");
  });

  it("123-S1: the scan reads the command and not the prose around it", () => {
    // The instrument, proved on input it must refuse: --production written in a
    // comment is not a build command that carries it.
    expect(compileCommands("# bun build --compile --production is what we should do\n")).toEqual([]);
    expect(compileCommands('  bun build --compile src/main.ts  # --production\n')[0]).not.toContain(
      "--production",
    );
    // Nor is one sitting in a neighbouring clause of the same script, which is
    // the shape package.json can take and release.yml cannot.
    expect(
      compileCommands("echo --production && bun build --compile src/main.ts --outfile dist/mdbrain")[0],
    ).not.toContain("--production");
    // And a command continued across lines is still one command, so a flag on
    // the continuation counts.
    expect(compileCommands('bun build --compile \\\n  --production src/main.ts\n')[0]).toContain(
      "--production",
    );
  });
});
