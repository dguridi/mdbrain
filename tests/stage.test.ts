import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { liveView } from "../src/run/screen.ts";
import { configureScreen } from "../src/configure/screen.ts";
import { configurePlan, isSceneId, liveViewState, SCENE_IDS, STAGED_HOME } from "../src/stage/scenes.ts";

const NOW = Date.UTC(2026, 9, 15, 17, 0, 0);
const MAIN = fileURLToPath(new URL("../src/stage/main.ts", import.meta.url));

const liveFrame = (now = NOW) =>
  render(liveView(liveViewState(now), { now, keysActive: true, selection: null })).lastFrame() ?? "";

describe("staged screens for the tutorial", () => {
  it("the live view shows a working agent, finished runs, the live link and the sweep countdown", () => {
    const frame = liveFrame();
    expect(frame).toContain("helper-bot");
    expect(frame).toContain("file-arrived #14 · inbox/kickoff-notes.md · Field Notes");
    expect(frame).toContain("research-bot");
    expect(frame).toContain("38m ago");
    expect(frame).toContain("listening for work");
    // One poll interval after the poll a minute ago, as `run` itself sets it.
    expect(frame).toContain("catch-up sweep in 44m");
    expect(frame).toContain("Identity only, not asked for work: notes-bot.");
  });

  it("the ages and the countdown read the same whenever the scene is drawn", () => {
    // Only the clock-of-day stamps follow the moment of drawing; everything a
    // reader compares across shots is a subtraction from it.
    const later = liveFrame(NOW + 3_600_000);
    expect(later).toContain("12m ago");
    expect(later).toContain("catch-up sweep in 44m");
  });

  it("no staged path names the machine that drew it", () => {
    const frame = liveFrame();
    expect(frame).toContain(`${STAGED_HOME}/.local/state/mdbrain/runs.jsonl`);
    expect(frame).not.toMatch(/AppData|\\/);
  });

  it("the configure scene opens on the agent picker with the staged roster", () => {
    const frame = render(configureScreen(configurePlan(), () => {})).lastFrame() ?? "";
    for (const name of ["helper-bot", "research-bot", "review-bot", "notes-bot"]) expect(frame).toContain(name);
  });

  it("a scene is named by its image id, and only those ids are scenes", () => {
    expect(SCENE_IDS.every(isSceneId)).toBe(true);
    expect(isSceneId("runner-nonsense")).toBe(false);
  });

  it("the stage lists its scenes without needing a terminal", () => {
    const listed = spawnSync(process.execPath, [MAIN, "--list"], { encoding: "utf8" });
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim().split(/\r?\n/)).toEqual([...SCENE_IDS]);
  });

  it("the stage refuses to draw into a pipe", () => {
    const piped = spawnSync(process.execPath, [MAIN, SCENE_IDS[0]], { encoding: "utf8" });
    expect(piped.status).toBe(1);
    expect(piped.stderr).toContain("has to be drawn in a terminal");
  });
});
