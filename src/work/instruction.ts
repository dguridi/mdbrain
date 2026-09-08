// What the claim answers, read into what a session needs — and the one refusal
// this program decides for itself.
//
// The server attributes work and takes it; what reaches this program is the
// body of that answer, JSON over the same session every other call here holds.
// This module turns that body into instructions and refusals, or into one
// sentence saying why it could not, and it decides nothing else. **Nothing here
// launches anything**: the loop that would poll, claim and start a session is
// deliberately absent from this program, and this is the pure edge it will read
// through when it arrives.
//
// **The prompt is read off the instruction and from nowhere else.** The brain's
// configuration is a file this program never opens; what the brain wants done
// travels as the prompt, and this module has no file, no clock and no socket in
// it, which is what lets that be checked rather than asserted.

/** The file the event names, when it names one. */
export interface InstructionFile {
  id: string;
  path: string;
}

/** What a session needs to start, and nothing else. */
export interface Instruction {
  claim: string;
  workspace: string;
  agent: string;
  prompt: string;
  /**
   * The file the trigger fired about, so the prompt can name it.
   *
   * **Null rather than absent, and the two are not the same thing here.** A
   * server that does not send one at all and an event that genuinely names no
   * file both read as null, because from this side they are the same fact: there
   * is nothing to substitute. What the prompt does about that is `renderPrompt`'s
   * to decide, and it refuses rather than substituting an empty string.
   */
  file: InstructionFile | null;
}

/** One unit of work as the server answers it: the instruction, in an envelope
 *  that makes the wake legible in a log. */
export interface WorkUnit {
  kind: string;
  seq: number;
  at: string;
  instruction: Instruction;
}

/** Work the server's cap held back, and which ceiling held it. `reason` is the
 *  sentence to print as it stands. */
export interface Refusal {
  agent: string;
  workspace: string;
  by: "runner" | "brain";
  heldBack: number;
  reason: string;
}

/** The claim's answer, or why it could not be read as one. */
export type WorkReading =
  | { kind: "work"; work: WorkUnit[]; refused: Refusal[] }
  | { kind: "unreadable"; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * Reads one unit as the server shapes it, or nothing.
 *
 * **All four fields or none.** An instruction missing its workspace is not a
 * unit this program can act on — a runner serving two brains cannot tell whose
 * work it is — and one missing its claim is a session nobody could ever report
 * against. Taking the readable half of a half-shaped answer would start sessions
 * on a server this program does not understand, so the whole answer is refused
 * instead.
 */
function readUnit(v: unknown): WorkUnit | null {
  if (!isRecord(v) || !isRecord(v.instruction)) return null;
  const i = v.instruction;
  if (!isText(i.claim) || !isText(i.workspace) || !isText(i.agent) || !isText(i.prompt)) return null;
  if (!isText(v.kind) || typeof v.seq !== "number" || !isText(v.at)) return null;
  const file = readFile(i.file);
  // A present-but-malformed file is refused, while an absent one is not: the
  // four fields above are what a session needs and this is not one of them, so a
  // server that has never heard of it must still be readable. A server that
  // sends one it cannot shape is answering something this version does not
  // understand, and acting on the rest would substitute half a fact.
  if (i.file !== undefined && i.file !== null && file === null) return null;
  return {
    kind: v.kind,
    seq: v.seq,
    at: v.at,
    instruction: { claim: i.claim, workspace: i.workspace, agent: i.agent, prompt: i.prompt, file },
  };
}

/** The instruction's file, or null when there is not a well-shaped one. */
function readFile(v: unknown): InstructionFile | null {
  if (!isRecord(v)) return null;
  if (!isText(v.id) || !isText(v.path)) return null;
  return { id: v.id, path: v.path };
}

function readRefusal(v: unknown): Refusal | null {
  if (!isRecord(v)) return null;
  if (!isText(v.agent) || !isText(v.workspace) || !isText(v.reason)) return null;
  if (v.by !== "runner" && v.by !== "brain") return null;
  if (typeof v.heldBack !== "number") return null;
  return { agent: v.agent, workspace: v.workspace, by: v.by, heldBack: v.heldBack, reason: v.reason };
}

/** The sentence for an answer this program will not act on. */
export const UNREADABLE_WORK_MESSAGE =
  "The server's answer did not carry instructions this version of mdbrain can read; nothing was started.";

/**
 * Reads the body of a claim into the work it carries and the work it withheld.
 *
 * @param body the parsed JSON body the claim answered with
 * @returns the instructions and refusals, or one sentence saying the answer was
 *   not one — in which case nothing in it is acted on
 */
export function readWork(body: unknown): WorkReading {
  if (!isRecord(body) || !Array.isArray(body.work)) return { kind: "unreadable", message: UNREADABLE_WORK_MESSAGE };
  const work: WorkUnit[] = [];
  for (const entry of body.work) {
    const unit = readUnit(entry);
    if (!unit) return { kind: "unreadable", message: UNREADABLE_WORK_MESSAGE };
    work.push(unit);
  }
  // Refusals are informational, so an absent list is an empty one — but a
  // present list is held to its shape, since a refusal this program cannot
  // print is one it cannot say out loud.
  const refused: Refusal[] = [];
  if (body.refused !== undefined) {
    if (!Array.isArray(body.refused)) return { kind: "unreadable", message: UNREADABLE_WORK_MESSAGE };
    for (const entry of body.refused) {
      const refusal = readRefusal(entry);
      if (!refusal) return { kind: "unreadable", message: UNREADABLE_WORK_MESSAGE };
      refused.push(refusal);
    }
  }
  return { kind: "work", work, refused };
}

/** An agent this program declined to ask for work, and the sentence saying why. */
export interface HeldAgent {
  agent: string;
  reason: string;
}

/**
 * Which of the configured agents to ask for work, given which already have a
 * session running here.
 *
 * **An agent with a session running is not asked, and that is the cap's other
 * half.** The server counts sessions an hour; only this program knows whether
 * one is running right now, so this is the refusal it owns. It is decided
 * before the claim is made rather than after, because a claim is terminal:
 * taking the work and then declining to start it would drop it, and the
 * server's answer to a unit nobody asked for is to keep it for the next poll.
 *
 * @param configured the agents this machine runs, as configured here
 * @param running the agents that have a session running right now
 * @returns the agents to name in the claim, and the ones held back with the
 *   sentence to print for each
 */
export function agentsToAsk(configured: readonly string[], running: ReadonlySet<string>): { ask: string[]; held: HeldAgent[] } {
  const ask: string[] = [];
  const held: HeldAgent[] = [];
  for (const agent of configured) {
    if (running.has(agent)) {
      held.push({
        agent,
        reason: `${agent}: a session is already running, so no second one is started. Its work waits for the next poll.`,
      });
      continue;
    }
    ask.push(agent);
  }
  return { ask, held };
}
