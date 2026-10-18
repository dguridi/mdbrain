// What a Claude Code session spent, read back from its own transcript.
//
// A session that is cut short (a stop, a time-out, a kill) never prints the
// result object its cost is normally read from, so its run-log row would say
// nothing about what it spent. The transcript Claude Code writes as it goes
// carries per-message token usage, and summing that, priced by `price.ts`,
// recovers the cost. Read once, when the session ends, because Claude Code
// deletes transcripts after a while and a later backfill would find nothing.
//
// The format is Claude Code's, not this program's, which is why the reading is
// one small module with its own tests rather than spread through the runner.
// What it relies on: each assistant message is written as several lines (one
// per content block) that all repeat the same `message.id` and usage, so lines
// are deduplicated by id keeping the last; a `<synthetic>` model marks a message
// made up locally with no usage; and subagents write their own files under
// `<claim>/subagents/`.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PathEnv } from "../config/paths.ts";

/** Tokens one model spent, split the way it is priced. */
export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes that live five minutes, priced at 1.25 times input. */
  cacheWrite5m: number;
  /** Cache writes that live an hour, priced at twice input. */
  cacheWrite1h: number;
}

/** What the transcripts of one session say it spent, inside its own time window. */
export interface TranscriptUsage {
  /** Tokens per model, keyed by the model's id with any `[…]` variant removed. */
  byModel: Record<string, ModelTokens>;
  /**
   * Tool calls the main conversation made. The harness's own turn count is
   * this plus one in most sessions, which is how it is reported; a call cut
   * off before its result still counts, so it is close rather than exact.
   */
  toolUses: number;
  /** Assistant messages counted, across every file. None means nothing was found. */
  messages: number;
  /** Of those, the main conversation's own, which is what a turn count rests on. */
  mainMessages: number;
}

/** A model id as it is priced: the `[1m]` context variant costs the same. */
export function baseModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

/**
 * The key a message's tokens are summed and priced under.
 *
 * A message served at a speed other than standard is priced differently, and
 * that price was never checked here, so its tokens go under a key of their own
 * that the price table does not hold. The session then prices as null, which is
 * honest, rather than at the standard rate, which would be a figure that looks
 * right and is too low. The tokens are kept either way.
 */
export function pricingKey(model: string, speed: unknown): string {
  const base = baseModel(model);
  return speed === undefined || speed === null || speed === "standard" ? base : `${base}@${String(speed)}`;
}

const NO_TOKENS: ModelTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The usage in one session's transcript files, inside a time window.
 *
 * Pure. `main` is the session's own transcript and `subagents` the files its
 * subagents wrote, each as text. Tool calls are counted from the main file
 * only, since they are what the harness's turn count follows; tokens are
 * counted from all of them, since all of them were spent on the session.
 *
 * The window matters because a resumed session keeps writing to the same file:
 * only messages stamped between the session's start and its end are its own.
 *
 * @param main the session's transcript, or null if it was not found
 * @param subagents its subagents' transcripts
 * @param from the session's start
 * @param to the session's end
 */
export function transcriptUsage(main: string | null, subagents: readonly string[], from: Date, to: Date): TranscriptUsage {
  const byModel: Record<string, ModelTokens> = {};
  let toolUses = 0;
  let messages = 0;
  let mainMessages = 0;

  const read = (text: string, countTools: boolean) => {
    // Last line per message id wins: the lines of one message repeat its usage,
    // and only the last carries the final output count.
    const last = new Map<string, { model: string; usage: Record<string, unknown> }>();
    const tools = new Set<string>();
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const e = entry as { type?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
      if (e.type !== "assistant" || typeof e.message !== "object" || e.message === null) continue;
      const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
      if (!Number.isFinite(at) || at < from.getTime() || at > to.getTime()) continue;
      const { id, model, usage, content } = e.message as { id?: unknown; model?: unknown; usage?: unknown; content?: unknown };
      if (typeof id !== "string" || typeof model !== "string" || model === "<synthetic>") continue;
      if (typeof usage === "object" && usage !== null) last.set(id, { model, usage: usage as Record<string, unknown> });
      if (countTools && Array.isArray(content)) {
        for (const block of content as { type?: unknown; id?: unknown }[]) {
          if (block?.type === "tool_use" && typeof block.id === "string") tools.add(block.id);
        }
      }
    }
    for (const { model, usage } of last.values()) {
      const key = pricingKey(model, usage.speed);
      // The split by lifetime when the message carries one, and otherwise every
      // write as a five-minute one, the cheaper of the two, so a message that
      // does not say is priced low rather than dropped.
      const split = (usage.cache_creation ?? null) as Record<string, unknown> | null;
      const written = count(usage.cache_creation_input_tokens);
      const hasSplit = split !== null && (typeof split.ephemeral_5m_input_tokens === "number" || typeof split.ephemeral_1h_input_tokens === "number");
      const fiveMinutes = hasSplit ? count(split?.ephemeral_5m_input_tokens) : written;
      const oneHour = hasSplit ? count(split?.ephemeral_1h_input_tokens) : 0;
      const sum = byModel[key] ?? { ...NO_TOKENS };
      byModel[key] = {
        input: sum.input + count(usage.input_tokens),
        output: sum.output + count(usage.output_tokens),
        cacheRead: sum.cacheRead + count(usage.cache_read_input_tokens),
        cacheWrite5m: sum.cacheWrite5m + fiveMinutes,
        cacheWrite1h: sum.cacheWrite1h + oneHour,
      };
      messages += 1;
      if (countTools) mainMessages += 1;
    }
    toolUses += tools.size;
  };

  if (main !== null) read(main, true);
  for (const text of subagents) read(text, false);
  return { byModel, toolUses, messages, mainMessages };
}

/**
 * Where Claude Code keeps its transcripts: `projects/` under its config
 * directory, which `CLAUDE_CONFIG_DIR` moves. The session inherits the runner's
 * environment (`childEnvironment`), so the runner's own variable is the one the
 * session used.
 */
export function claudeProjectsDir(env: PathEnv): string {
  const configured = env.env.CLAUDE_CONFIG_DIR;
  return join(configured !== undefined && configured !== "" ? configured : join(env.home, ".claude"), "projects");
}

/**
 * Reads one session's transcripts and answers their usage inside its window,
 * or null when no transcript of that id exists.
 *
 * Found by name rather than by working out the folder: Claude Code files a
 * transcript under an encoding of the working directory that is its own
 * business, and is not even stable in case. The claim id is unique, so a
 * search over every project folder finds the one file.
 */
export async function readTranscriptUsage(projectsDir: string, claim: string, from: Date, to: Date): Promise<TranscriptUsage | null> {
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const project of projects) {
    let main: string;
    try {
      main = await readFile(join(projectsDir, project, `${claim}.jsonl`), "utf8");
    } catch {
      continue;
    }
    const subagentDir = join(projectsDir, project, claim, "subagents");
    const subagents: string[] = [];
    try {
      for (const name of await readdir(subagentDir)) {
        if (name.endsWith(".jsonl")) subagents.push(await readFile(join(subagentDir, name), "utf8"));
      }
    } catch {
      // A session with no subagents has no folder for them.
    }
    return transcriptUsage(main, subagents, from, to);
  }
  return null;
}
