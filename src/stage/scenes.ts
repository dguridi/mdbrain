// Made-up state for the runner's real screens, so the tutorial can show them.
//
// A screenshot of `mdbrain run` on a real machine is a screenshot of somebody's
// real agents, brains and file paths, and the runner talks only to production —
// there is no dev stack to point it at. So the pictures are staged instead: the
// screens drawn here are the ones the commands draw, built by the same reducer
// from the same events, and only the events are invented. A change to a screen
// therefore shows up in the next picture without anything here being touched.
//
// **Every name here is fictional on purpose**, and they are the names the
// tutorials already use (`helper-bot`, a brain called `Field Notes`, an
// organization called `Riverbend`), so a reader meets the same cast in the prose
// and in the picture.
//
// **Nothing here reads a clock.** A scene is built against the moment it is
// handed, so a test can draw it at a fixed instant and the stage can hold one
// frame still — the countdown and every age are subtractions from that moment.

import { POLL_MS } from "../config/schema.ts";
import { summaryLines } from "../run/loop.ts";
import { runLogPath } from "../run/log.ts";
import type { RunEvent } from "../run/present.ts";
import { applyEvent, emptyView, type ViewState } from "../run/view.ts";
import { agentChoices, type RosterAgent } from "../configure/questions.ts";
import type { ScreenPlan } from "../configure/screen.ts";

/** The ids a scene is staged by, which are also the image names the tutorial asks for. */
export const SCENE_IDS = ["runner-live-view", "runner-configure-agents"] as const;

/** One scene. Its id is the PNG's base name, which is what ties it to the tutorial's request. */
export type SceneId = (typeof SCENE_IDS)[number];

/** Whether a typed name is a scene that can be staged. */
export function isSceneId(id: string): id is SceneId {
  return (SCENE_IDS as readonly string[]).includes(id);
}

/** The home directory every staged path is under, so no real user name is drawn. */
export const STAGED_HOME = "/home/you";

/**
 * The run log's address as a Linux machine would print it.
 *
 * Pinned to Linux rather than read from the machine staging it, because the
 * picture is of the reader's terminal in general and not of whoever took it.
 */
const STAGED_RUN_LOG = runLogPath({ platform: "linux", home: STAGED_HOME, env: {} }).replaceAll("\\", "/");

const MINUTE = 60_000;

/**
 * The events behind the live-view picture, stamped against `now`.
 *
 * Chosen to show the screen doing the things the tutorial describes: three
 * agents, one of them working on a file that just arrived, two sessions that
 * finished earlier, the work-signal connection up, and the catch-up sweep
 * counting down. One agent is identity-only, so the summary line that says so
 * appears — it is the line a reader is most likely to wonder about.
 */
function liveViewEvents(now: number): Array<{ event: RunEvent; at: Date }> {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE);
  const startup = { asking: ["helper-bot", "research-bot", "review-bot"], held: [], attended: ["notes-bot"] };
  const events: Array<[number, RunEvent]> = [
    [52, { kind: "summary", lines: summaryLines(startup, STAGED_RUN_LOG, null) }],
    [52, { kind: "configured", agent: "helper-bot" }],
    [52, { kind: "configured", agent: "research-bot" }],
    [52, { kind: "configured", agent: "review-bot" }],
    [52, { kind: "listening", state: "listening", held: 1, total: 1 }],
    [52, { kind: "connection", state: "connected" }],
    [
      38,
      {
        kind: "done",
        agent: "research-bot",
        claim: "7c1e94d2-5b0a-4f3e-9a61-2d8b7f40c3aa",
        ms: 4 * MINUTE + 12_000,
        costUsd: 0.38,
        turns: 14,
        message: "Summarised the three interview notes in research/ on a comment thread.",
      },
    ],
    [
      12,
      {
        kind: "done",
        agent: "review-bot",
        claim: "e90b3f17-2c4d-4a88-b1f5-6a07d9c2e815",
        ms: 65_000,
        costUsd: 0.09,
        turns: 4,
        message: "Left two comments on drafts/launch-plan.md.",
      },
    ],
    [1, { kind: "poll", agents: ["helper-bot", "research-bot", "review-bot"], waiting: 1 }],
    [
      1,
      {
        kind: "start",
        agent: "helper-bot",
        claim: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        unitKind: "file-arrived",
        seq: 14,
        workspace: "00000000-0000-4000-8000-000000000000",
        file: "inbox/kickoff-notes.md",
        brain: "Field Notes",
        recordedAt: at(1.5).toISOString(),
      },
    ],
    // Due one poll interval after the poll above, which is how `run` sets it, so
    // the countdown agrees with the events beside it.
    [1, { kind: "phase", phase: { kind: "waiting", at: at(1).getTime() + POLL_MS } }],
  ];
  return events.map(([minutesAgo, event]) => ({ event, at: at(minutesAgo) }));
}

/**
 * The live view's state for the picture.
 *
 * Built by `applyEvent`, which is the reducer `mdbrain run` itself draws from,
 * so the picture cannot show a state the runner could not reach.
 *
 * @param now the instant the frame is drawn at, in epoch milliseconds
 */
export function liveViewState(now: number): ViewState {
  return liveViewEvents(now).reduce((view, { event, at }) => applyEvent(view, event, at), emptyView);
}

/** The roster the configure picture offers: four agents in one organization. */
const STAGED_ROSTER: RosterAgent[] = [
  { id: "a1b2c3d4-0000-4000-8000-000000000001", name: "helper-bot", organization: "Riverbend", status: "active" },
  { id: "a1b2c3d4-0000-4000-8000-000000000002", name: "research-bot", organization: "Riverbend", status: "active" },
  { id: "a1b2c3d4-0000-4000-8000-000000000003", name: "review-bot", organization: "Riverbend", status: "active" },
  { id: "a1b2c3d4-0000-4000-8000-000000000004", name: "notes-bot", organization: "Riverbend", status: "active" },
];

/** The checkout every staged agent is offered as its working directory. */
export const STAGED_CHECKOUT = `${STAGED_HOME}/code/field-notes`;

/**
 * What `mdbrain configure` would be handed for a first run on this roster.
 *
 * A first run, so nothing is preselected and no draft is offered: that is the
 * screen a reader following the tutorial actually meets. Every directory is
 * accepted and none has children, which keeps Tab completion from listing
 * anything off the machine doing the staging. Every environment variable reads
 * as set, so naming one draws no *not set in this shell* warning: that warning is
 * about the staging machine's shell, not the reader's.
 */
export function configurePlan(): ScreenPlan {
  return {
    choices: agentChoices(STAGED_ROSTER, null),
    emptyOrganizations: [],
    withheld: null,
    existing: null,
    draft: null,
    currentDirectory: STAGED_CHECKOUT,
    env: new Proxy({}, { get: () => "set" }),
    isDirectory: () => true,
    listDirectory: () => [],
  };
}
