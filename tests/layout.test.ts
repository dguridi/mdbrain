import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../", import.meta.url));
const DOC = `${APP}AGENTS.md`;

/** The rows of the Layout block, as name → the prose after it. */
const layoutRows = (): Map<string, string> => {
  const doc = readFileSync(DOC, "utf8");
  const block = /## Layout\r?\n\r?\n```\r?\n([\s\S]*?)\r?\n```/.exec(doc);
  if (!block) throw new Error("AGENTS.md has no fenced Layout block");
  const rows = new Map<string, string>();
  for (const line of block[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const split = /^(\S+)\s+(\S.*)$/.exec(line);
    if (!split) throw new Error(`Layout row is not "name description": ${line}`);
    // A Map would let a second row for the same path quietly replace the first,
    // so a stale leftover beside a corrected row would satisfy every rule below
    // — which is this file's own defect written into its instrument.
    if (rows.has(split[1])) throw new Error(`Layout has two rows for ${split[1]}`);
    rows.set(split[1], split[2]);
  }
  return rows;
};

const modules = (): string[] =>
  readdirSync(`${APP}src`, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `src/${entry.split("\\").join("/")}`)
    .sort();

// Recursive because `vitest.config.ts` includes `tests/**/*.test.ts`: a file in
// a subdirectory runs in CI, so it is one of the files this list is for.
const testFiles = (): string[] =>
  readdirSync(`${APP}tests`, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => `tests/${entry.split("\\").join("/")}`)
    .sort();

// The trailing letter is part of the id: spec 96's scenarios have lettered
// parts, and a pattern stopping at the digits would read a lettered one as a
// claim about an unlettered scenario that does not exist. Described rather than
// illustrated, because this file is one of the files the rules below read — an
// id in a comment here would be a scenario this file was claiming to carry.
const ID = /\b(\d{2,3})-S(\d+[a-z]?)\b/g;

const specsIn = (text: string): string[] =>
  [...new Set([...text.matchAll(ID)].map((hit) => hit[1]))].sort();

const idsIn = (text: string): string[] => [
  ...new Set([...text.matchAll(ID)].map((hit) => `${hit[1]}-S${hit[2]}`)),
];

// A row writes a run of scenarios as a range and spells the spec number once,
// on the left, so the far end of a range arrives bare. Both ends are claims
// about the row's own file, so the right one inherits the spec most recently
// named — while a bare id standing on its own keeps meaning a scenario
// somewhere else, which is the distinction the notation already draws. Reading
// only the prefixed spelling would leave the end of a range the one position on
// a row that can name a scenario its file does not have and be believed, and a
// range whose far end drifted is the shape that lands there. Described rather
// than illustrated, for the reason the id pattern above is.
const claimedIn = (row: string): string[] => {
  const ids = new Set(idsIn(row));
  const token = /\b\d{2,3}-S\d+[a-z]?\b|\bS\d+[a-z]?\b|\bto\b/g;
  let spec: string | null = null;
  let afterTo = false;
  for (const [text] of row.matchAll(token)) {
    if (text === "to") {
      afterTo = true;
      continue;
    }
    const prefixed = /^(\d{2,3})-S\d+[a-z]?$/.exec(text);
    if (prefixed) spec = prefixed[1];
    else if (afterTo && spec) ids.add(`${spec}-${text}`);
    afterTo = false;
  }
  return [...ids];
};

// AGENTS.md is on the release workflow's withheld list while `tests/` is on its
// published one, so this file is copied into the public snapshot repository
// without the document it reads. Absent means not-here rather than deleted, and
// a skip is the honest answer; a collection error there would be noise nobody in
// that repository can act on.
const d = existsSync(DOC) ? describe : describe.skip;

d("the Layout block in AGENTS.md, read back against the tree", () => {
  it("parses as rows at all, so nothing below can pass by finding nothing", () => {
    const rows = layoutRows();
    expect(rows.size).toBeGreaterThan(50);
    expect(rows.get("src/main.ts")).toContain("entry point");
    expect(modules().length).toBeGreaterThan(40);
    expect(testFiles()).toContain("tests/layout.test.ts");
  });

  it("has a row for every module", () => {
    const rows = layoutRows();
    expect(modules().filter((path) => !rows.has(path))).toEqual([]);
  });

  it("has a row for every test file", () => {
    const rows = layoutRows();
    expect(testFiles().filter((path) => !rows.has(path))).toEqual([]);
  });

  it("names nothing that is not there", () => {
    const known = new Set([...modules(), ...testFiles()]);
    expect([...layoutRows().keys()].filter((path) => !known.has(path))).toEqual([]);
  });

  it("names, on each test's row, exactly the specs that file carries ids from", () => {
    const rows = layoutRows();
    // Both directions in one assertion: a row that forgot a spec and a row that
    // claims one its file never had are the same defect — a record nobody read
    // back — and the second is the one a correction by hand tends to leave.
    const carried = testFiles().map((path) => ({
      path,
      inFile: specsIn(readFileSync(`${APP}${path}`, "utf8")),
      onRow: specsIn(rows.get(path) ?? ""),
    }));
    expect(carried.flatMap(({ inFile }) => inFile)).toContain("125");
    expect(carried.filter(({ inFile, onRow }) => inFile.join() !== onRow.join())).toEqual([]);
  });

  it("writes no scenario id on a row whose file does not carry it", () => {
    // The spec-level rule above cannot see a range that drifted inside the spec
    // it names, which is how a row comes to claim a scenario that lives in a
    // different file. A prefixed id, and the far end of a range, are claims
    // about *this* file; a pointer to one somewhere else stands on its own and
    // is written bare, as `S9` on the presence row is.
    const rows = layoutRows();
    const claimed = testFiles().map((path) => ({
      path,
      absent: claimedIn(rows.get(path) ?? "").filter(
        (id) => !idsIn(readFileSync(`${APP}${path}`, "utf8")).includes(id),
      ),
    }));
    expect(claimed.flatMap(({ absent }) => absent)).toEqual([]);
  });
});
