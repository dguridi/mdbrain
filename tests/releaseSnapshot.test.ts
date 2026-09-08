import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../../../.github/workflows/release.yml", import.meta.url));

/** The words of a `name="a b c"` line in the workflow's snapshot step. */
const listNamed = (name: string): string[] => {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const found = new RegExp(`^\\s*${name}="([^"]*)"`, "m").exec(yaml);
  if (!found) throw new Error(`release.yml has no ${name}= line`);
  return found[1].split(/\s+/).filter(Boolean);
};

// git rather than a directory listing: node_modules and dist are on disk here
// and are not what a release publishes, and the workflow asks git the same way.
const trackedTopLevel = (): string[] | null => {
  const run = spawnSync("git", ["ls-files", "apps/agent-runner"], { cwd: ROOT, encoding: "utf8" });
  if (run.status !== 0) return null;
  const names = run.stdout.split("\n").map((line) => line.split("/")[2]).filter(Boolean);
  return [...new Set(names)].sort();
};

const tracked = trackedTopLevel();
const d = tracked && tracked.length > 0 ? describe : describe.skip;

// Nothing is read at suite level, and that is not style: a skipped suite still
// runs its factory, and this file is itself copied into the public snapshot
// repository, where `.github/` is not carried. Reading the workflow there would
// be a collection error rather than the skip the guard is asking for.
d("what a release publishes to the public repository", () => {
  it("109-S25: every tracked entry is on one of the two lists", () => {
    // The point of the lists is that adding a file to apps/agent-runner/ is a
    // decision about whether strangers read it. Naming a directory instead made
    // that decision silently, in the direction of publishing.
    const classified = new Set([...listNamed("published"), ...listNamed("withheld")]);
    const unclassified = (tracked as string[]).filter((entry) => !classified.has(entry));
    expect(unclassified).toEqual([]);
  });

  it("109-S25: and on only one of them", () => {
    const withheld = listNamed("withheld");
    expect(listNamed("published").filter((entry) => withheld.includes(entry))).toEqual([]);
  });

  it("109-S25: the agent context is withheld", () => {
    // Not incidental: the spec's own account of what staying private buys names
    // AGENTS.md, and the ruling that sent the source across did not overturn it.
    const published = listNamed("published");
    const withheld = listNamed("withheld");
    expect(withheld).toContain("AGENTS.md");
    expect(withheld).toContain("CLAUDE.md");
    expect(published).not.toContain("AGENTS.md");
    expect(published).not.toContain("CLAUDE.md");
  });

  it("109-S25: the release front page is copied once, under the name it takes", () => {
    // RELEASE-README.md becomes the public README.md, so copying it under its
    // own name as well would leave a stray duplicate beside its own front page.
    const published = listNamed("published");
    expect(published).not.toContain("RELEASE-README.md");
    expect(published).not.toContain("README.md");
    expect(readFileSync(WORKFLOW, "utf8")).toContain(
      'cp apps/agent-runner/RELEASE-README.md "$work/README.md"',
    );
  });

  it("109-S25: the source and its tests are published", () => {
    const published = listNamed("published");
    expect(published).toContain("src");
    expect(published).toContain("tests");
  });

  it("109-S25: and the copy is driven by that list, not by the directory", () => {
    // The lists only decide what a release publishes if the copy CONSULTS them.
    // Every assertion above reads the two `name="..."` lines, so all of them
    // survive a step that classifies faithfully and then copies the subtree
    // anyway — which is the whole defect the lists were written to prevent, and
    // it would reach a public repository on the next tag.
    //
    // Collected rather than searched for: asking whether some correct-looking
    // copy exists is satisfied by one of two, so a second, wider one added
    // beside it goes unseen. The list is the assertion.
    // Every line that touches the snapshot working tree, not just the ones
    // spelled `cp`: pinning the copies alone would leave an `rsync`, a `tar -C`
    // or a redirect added beside them invisible, and each of those publishes a
    // subtree exactly as a wider `cp` would.
    const yaml = readFileSync(WORKFLOW, "utf8");
    const touchesTheSnapshot = [...yaml.matchAll(/^\s*(\S.*"\$work.*)$/gm)].map((m) => m[1]);
    expect(touchesTheSnapshot).toEqual([
      '"https://x-access-token:${RELEASE_REPO_TOKEN}@github.com/dguridi/mdbrain.git" "$work"',
      'find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +',
      'cp -R "apps/agent-runner/$entry" "$work/$entry"',
      'cp apps/agent-runner/RELEASE-README.md "$work/README.md"',
      'cd "$work"',
    ]);
    // The positive control for the slice above: `$entry` is only the published
    // list if something iterates it, so an assertion about the copy that did
    // not also pin the loop would pass for a loop over anything at all.
    expect(yaml).toContain("for entry in $published; do");
  });
});
