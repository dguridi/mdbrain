// Draws one staged screen in this terminal and holds it still for a screenshot.
//
// The pictures in the runner's tutorial are of a real terminal — its font, its
// theme, its window — so they are taken by hand rather than by the browser-driven
// screenshot harness. This is the half that can be automated: it clears the
// terminal, draws the scene from `scenes.ts`, and waits. Whoever is taking the
// picture screenshots the window and quits.
//
// Started as `npm run dev shots stage <id>` from the repo root, or directly as
// `node apps/agent-runner/src/stage/main.ts <id>`. Not part of the `mdbrain`
// binary: the build bundles `src/main.ts` and what it imports, and nothing
// there imports this.
//
// Built with `createElement` rather than JSX, so `node` runs it unbuilt, as it
// does `src/main.ts`.

import { createElement as h, type ReactElement } from "react";
import { render, useApp, useInput } from "ink";
import { liveView } from "../run/screen.ts";
import { configureScreen } from "../configure/screen.ts";
import { configurePlan, isSceneId, liveViewState, SCENE_IDS, type SceneId } from "./scenes.ts";

/**
 * Keeps a still frame on screen until `q` or Ctrl-C.
 *
 * The live view is drawn once, at one instant, so its countdown and its ages do
 * not move between the moment the window is framed and the moment it is
 * captured. Reading keys is also what keeps the process alive: a frame with
 * nothing listening would be drawn and the program would exit under it.
 */
function Hold({ frame }: { frame: ReactElement }): ReactElement {
  const { exit } = useApp();
  useInput((input) => {
    if (input === "q") exit();
  });
  return frame;
}

/**
 * The element for one scene.
 *
 * The configure scene is the real question sequence and stays interactive, so
 * any of its questions can be reached with the keys a reader would press. It
 * exits itself when the sequence ends, or on Ctrl-C, and the answers are
 * dropped: nothing staged is ever written.
 */
function sceneFor(id: SceneId, now: number): ReactElement {
  switch (id) {
    case "runner-live-view":
      return h(Hold, { frame: liveView(liveViewState(now), { now, keysActive: true, selection: null }) });
    case "runner-configure-agents":
      return configureScreen(configurePlan(), () => {});
  }
}

const USAGE = `Usage: node apps/agent-runner/src/stage/main.ts <scene>

Draws one of the runner's screens from made-up state, for a tutorial screenshot.
Scenes: ${SCENE_IDS.join(", ")}`;

/**
 * Stages the scene named in `argv`, or lists the scenes for `--list`.
 *
 * @returns the exit code: 0 once a scene was drawn and quit, a list printed or
 *   help asked for; 1 for no scene named, an unknown one, or no terminal to draw in
 */
async function main(argv: string[]): Promise<number> {
  const [id] = argv;
  if (id === "--list") {
    for (const scene of SCENE_IDS) console.log(scene);
    return 0;
  }
  if (id === undefined || id === "-h" || id === "--help") {
    console.log(USAGE);
    return id === undefined ? 1 : 0;
  }
  if (!isSceneId(id)) {
    console.error(`No scene called ${id}.\n${USAGE}`);
    return 1;
  }
  // Ink reads keys in raw mode, which a pipe cannot be put in — and a staged
  // screen nobody can see is not worth drawing anyway.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("A scene has to be drawn in a terminal: run this directly, not through a pipe.");
    return 1;
  }

  // Cleared, scrollback included, so the command that started this is not in
  // the picture above the scene.
  process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
  await render(sceneFor(id, Date.now()), { exitOnCtrlC: true }).waitUntilExit();
  // Said after the frame is gone, so it is never in the picture. The size is
  // what decides how the frame wrapped, and is worth writing down beside a shot.
  console.log(`Staged ${id} at ${process.stdout.columns}×${process.stdout.rows}.`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
