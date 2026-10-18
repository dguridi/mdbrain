import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const OLD_NAME = /markdown[-_ ]?den/i;

// Each entry is one line by file and a piece of its text, with the reason that
// line has to keep the old name. A host is not a word: runners already
// installed call that origin, and the comment saying so has to name it.
const OLD_NAME_ALLOWED: { file: string; contains: string; because: string }[] = [
  {
    file: "auth/project.ts",
    contains: "`https://www.markdown-den.com/api/…`",
    because: "the origin installed runners still call, named so the server keeps serving /api there",
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

function linesNaming(pattern: RegExp): { file: string; line: number; text: string }[] {
  return sourceFiles(SRC).flatMap((path) => {
    const file = relative(SRC, path).split("\\").join("/");
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((text, i) => ({ file, line: i + 1, text }))
      .filter((l) => pattern.test(l.text));
  });
}

describe("the runner calls the product markdownbrain.ai", () => {
  it("says the old name nowhere in its source but the package scope and the hosts it still calls", () => {
    // The positive control: what is asserted below is an absence, and a scan
    // that had stopped reading would report one just as happily.
    expect(
      linesNaming(/markdownbrain\.ai/).some((l) => l.file === "cli.ts"),
      "the scan is not reading the help banner — the absence asserted below is worthless until it does",
    ).toBe(true);

    const found = linesNaming(OLD_NAME);
    const unexplained = found.filter(
      (l) =>
        // The package scope is a workspace identifier, not the product's name,
        // and it stays what it is.
        OLD_NAME.test(l.text.replace(/@markdown-den\//g, "")) &&
        !OLD_NAME_ALLOWED.some((a) => a.file === l.file && l.text.includes(a.contains)),
    );
    expect(unexplained.map((l) => `${l.file}:${l.line} ${l.text.trim()}`)).toEqual([]);

    // An entry nothing matches any more is a licence waiting for a line to use
    // it; it goes when its line does.
    const stale = OLD_NAME_ALLOWED.filter((a) => !found.some((l) => l.file === a.file && l.text.includes(a.contains)));
    expect(stale).toEqual([]);
  });
});
