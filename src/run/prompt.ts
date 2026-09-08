// Rendering the prompt a trigger's author wrote into the prompt a session is
// given.
//
// A trigger fires because a particular file arrived or changed, and the person
// who wrote the prompt should be able to name it. `{path}` and `{id}` stand for
// that file and are replaced at the moment the session starts. Nothing else in
// the prompt is touched, and the prompt still travels verbatim in every other
// respect.
//
// **An unrecognised placeholder is refused rather than passed through, and that
// is the one opinion here.** A prompt reaching a harness with `{paht}` still in
// it is a prompt an agent spends real money acting on, and a session that wasted
// money is indistinguishable from one that worked. Refusing costs one unit of
// work and names the word that was wrong; passing through costs a run and says
// nothing.
//
// **What counts as a placeholder is deliberately narrow**: a brace, one or more
// of `A-Za-z0-9_`, a brace. A prompt carrying JSON is untouched, because
// `{"key": "value"}` holds characters this does not match. That is the whole
// rule — there is no escape syntax, because inventing one unilaterally would
// settle a question that has not been asked yet, and a prompt that legitimately
// wants a bare `{word}` is the case that would need it.
//
// **What a substituted value can do, said out loud rather than left to be
// discovered.** A path is a workspace member's file name, and it now lands
// verbatim in the prompt — which is the highest-trust position in a session,
// above anything a tool later returns. There is no shell anywhere on this path,
// so this is not command injection: the harness is spawned with an argument
// vector. It is prompt injection, and the honest sizing is that it moves the
// exposure rather than creating it — an agent woken on a folder would have read
// the hostile file with its own tools anyway. What is new is the position, and
// a delimiter around substituted values would narrow it. That is a decision
// about what every prompt looks like, so it is raised rather than taken.
//
// Pure: text and values in, a rendered prompt or a refusal out. No process, no
// clock, no disk.
//
// **The recognised names are also declared in `packages/collab-core`**, whose
// validator refuses an unknown placeholder where the brain's configuration is
// written — which is the only place the author can fix it, and much earlier than
// here. The duplication is deliberate: this program imports nothing from the
// repo's apps or packages, because it is meant to be cheap to lift into its own
// repository, and one shared list would buy agreement at the price of that.
// This check is the backstop for a configuration written before that one existed.

/** The file a trigger fired about, when its event names one. */
export interface TriggerFile {
  id: string;
  path: string;
}

/** The placeholders a prompt may use, and what each stands for. */
export const PLACEHOLDERS: Readonly<Record<string, (file: TriggerFile) => string>> = Object.freeze({
  path: (file) => file.path,
  id: (file) => file.id,
});

/**
 * What a placeholder looks like.
 *
 * Narrow on purpose — see this file's header. Anchored to word characters so a
 * prompt containing an object literal, a shell brace expansion or prose with a
 * space inside braces is not read as naming anything.
 */
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/** The recognised names, in a stable order, for a refusal to list. */
export function placeholderNames(): string[] {
  return Object.keys(PLACEHOLDERS).sort();
}

/** A rendered prompt, or the sentence saying why there is not one. */
export type Rendered = { ok: true; prompt: string } | { ok: false; reason: string };

/**
 * The prompt a session is actually given.
 *
 * Substitution is a single pass, which is what stops a value that happens to
 * contain braces from being read as a placeholder in its own right: a file
 * genuinely named `{id}.md` substitutes once and is then left alone.
 *
 * @param prompt the trigger author's prompt, as it arrived in the instruction
 * @param file the file the event names, or null when it names none
 * @returns the rendered prompt, or a refusal naming what could not be resolved
 */
export function renderPrompt(prompt: string, file: TriggerFile | null): Rendered {
  const unknown: string[] = [];
  const needsFile: string[] = [];

  const rendered = prompt.replace(PLACEHOLDER, (whole, name: string) => {
    const resolve = Object.prototype.hasOwnProperty.call(PLACEHOLDERS, name) ? PLACEHOLDERS[name] : undefined;
    if (resolve === undefined) {
      if (!unknown.includes(name)) unknown.push(name);
      return whole;
    }
    if (file === null) {
      if (!needsFile.includes(name)) needsFile.push(name);
      return whole;
    }
    return resolve(file);
  });

  // The unrecognised name is reported first when both are wrong: a typo is the
  // author's mistake and fixable by them, while a missing file is a fact about
  // the event, and telling somebody about the second while the first is still
  // there sends them to look in the wrong place.
  if (unknown.length > 0) {
    const named = unknown.map((n) => `{${n}}`).join(", ");
    const known = placeholderNames().map((n) => `{${n}}`).join(" and ");
    return {
      ok: false,
      reason:
        `The prompt uses ${named}, which ${unknown.length === 1 ? "is not a placeholder" : "are not placeholders"} ` +
        `this runner knows. The ones that exist are ${known}. Nothing was started, and this unit of work is spent — ` +
        `fix the prompt in the brain's configuration before the trigger fires again.`,
    };
  }

  if (needsFile.length > 0) {
    const named = needsFile.map((n) => `{${n}}`).join(", ");
    return {
      ok: false,
      reason:
        `The prompt uses ${named}, but the event that fired this trigger names no file, so there is nothing to ` +
        `substitute. Nothing was started, and this unit of work is spent.`,
    };
  }

  return { ok: true, prompt: rendered };
}
