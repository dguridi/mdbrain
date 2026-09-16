// Which agent an invocation of `as` means — decided from what was typed and what
// this machine is configured for, and nothing else.
//
// It is pure and it is separate from the command because the decision is the
// part worth exercising: every interesting case is a shape of the configured
// list, and a rule that could only be tried by typing at a real terminal is one
// nobody tries. The command keeps the order and the refusals; this keeps the
// judgement.
//
// **The rule is the one every shell has already taught everybody**: a prefix
// that picks out one name is that name, a prefix that picks out several asks
// which, and a prefix that picks out none is a mistake. What is deliberately
// *not* here is matching anywhere in the name — a substring rule makes the set
// of matches something a person has to reason about instead of read, and a
// wrong guess here starts a real session as the wrong bot.

/** What a typed name came to: one agent, several, or nothing configured here. */
export type Resolution =
  | { kind: "one"; name: string }
  | { kind: "many"; matches: string[] }
  | { kind: "none" };

/**
 * Resolve what was typed against the agents configured on this machine.
 *
 * Matching folds case, because a name is typed by a person and a roster name
 * carries whatever capitals its author gave it. **An exact match wins over every
 * prefix**, and that is the case worth stating: where one agent's whole name is
 * the start of another's, a rule that only knew about prefixes would make the
 * shorter name the one name on the machine that cannot be asked for.
 *
 * @param typed what the person wrote after `as` — an empty string means they
 * wrote nothing, which matches everything and so asks
 * @param configured the agent names, in the order the configuration holds them,
 * which is the order any list of them is shown in
 */
export function resolveAgent(typed: string, configured: string[]): Resolution {
  // A name typed exactly is that name, even where another configured name folds to
  // the same text: the fold below is a convenience, and it must not be able to make
  // a name that was typed correctly ambiguous.
  if (configured.includes(typed)) return { kind: "one", name: typed };

  const folded = typed.toLowerCase();
  const same = configured.filter((name) => name.toLowerCase() === folded);
  const matches = same.length > 0 ? same : configured.filter((name) => name.toLowerCase().startsWith(folded));

  if (matches.length === 1) return { kind: "one", name: matches[0] };
  if (matches.length > 1) return { kind: "many", matches };
  return { kind: "none" };
}

/**
 * The refusal for a prefix that names more than one agent, where there is no
 * terminal to ask at.
 *
 * It names the matches rather than only counting them, because the whole of the
 * remedy is typing one more character and the person cannot know which character
 * without seeing what they are telling apart.
 */
export function ambiguousAgentMessage(typed: string, matches: string[]): string {
  return `${typed} names more than one agent configured here: ${matches.join(", ")}. Type enough of one to tell it apart.`;
}

/**
 * The question above the list, which says why the list is being shown.
 *
 * A picker that appeared with no explanation after a name was typed reads as
 * though the name was ignored; saying how many matched, and what they matched,
 * makes it the answer to what was asked.
 */
export function pickerHeading(typed: string | null, matches: string[]): string {
  if (typed === null || typed === "") return "Which agent should this session be?";
  return `${matches.length} agents here start with ${typed}. Which one?`;
}
