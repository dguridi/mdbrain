import { describe, it, expect } from "vitest";
import { MENTIONS_NOT_RECORDED, PLACEHOLDERS, placeholderNames, renderPrompt } from "../src/run/prompt.ts";

const file = { id: "9f1e-4d2c", path: "01-ideas/37-a-doctor-command.md" };

const rendered = (prompt: string, f = file as { id: string; path: string } | null) => {
  const out = renderPrompt(prompt, f);
  if (!out.ok) throw new Error(`expected a rendered prompt, got a refusal: ${out.reason}`);
  return out.prompt;
};

const refusal = (prompt: string, f = file as { id: string; path: string } | null) => {
  const out = renderPrompt(prompt, f);
  if (out.ok) throw new Error(`expected a refusal, got: ${out.prompt}`);
  return out.reason;
};

describe("105-S74: the prompt can name the file that triggered it", () => {
  it("substitutes {path} and {id}", () => {
    expect(rendered("Read {path} and report.")).toBe("Read 01-ideas/37-a-doctor-command.md and report.");
    expect(rendered("The node is {id}.")).toBe("The node is 9f1e-4d2c.");
    expect(rendered("{path} ({id})")).toBe("01-ideas/37-a-doctor-command.md (9f1e-4d2c)");
  });

  it("replaces every occurrence, not only the first", () => {
    expect(rendered("{path}, then {path} again")).toBe(
      "01-ideas/37-a-doctor-command.md, then 01-ideas/37-a-doctor-command.md again",
    );
  });

  it("leaves a prompt with no placeholders byte for byte alone", () => {
    const plain = "Check in.\n\nRead the playbook first.\n";
    expect(rendered(plain)).toBe(plain);
  });

  it("substitutes in one pass, so a value that looks like a placeholder is not re-read", () => {
    // A file genuinely called `{id}.md` is substituted once and then left alone.
    const odd = { id: "abc", path: "notes/{id}.md" };
    expect(rendered("Open {path}.", odd)).toBe("Open notes/{id}.md.");
  });
});

describe("105-S75: an unrecognised placeholder fails loudly rather than passing through", () => {
  it("names the offending placeholder and lists the ones that exist", () => {
    const reason = refusal("Read {paht} and report.");
    expect(reason).toContain("{paht}");
    expect(reason).toContain("{id}");
    expect(reason).toContain("{path}");
  });

  it("never returns a prompt carrying the typo, which is the failure this prevents", () => {
    const out = renderPrompt("Read {paht}.", file);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("Read {paht}.");
  });

  it("reports every distinct unknown name once", () => {
    const reason = refusal("{foo} {bar} {foo}");
    expect(reason).toContain("{foo}");
    expect(reason).toContain("{bar}");
    expect(reason.match(/\{foo\}/g)).toHaveLength(1);
  });

  it("reports the typo ahead of a missing file when both are wrong", () => {
    // The typo is the author's to fix; being sent to look at the event instead
    // sends them to the wrong place.
    const reason = refusal("{paht} in {path}", null);
    expect(reason).toContain("{paht}");
    expect(reason).not.toContain("names no file");
  });
});

describe("105-S76: what is not a placeholder", () => {
  it("leaves an object literal in a prompt alone", () => {
    const json = 'Answer with {"status": "done", "seen": 3}.';
    expect(rendered(json)).toBe(json);
  });

  it("leaves braces holding anything but word characters alone", () => {
    for (const text of ["{ path }", "{path-of}", "{}", "{a.b}", "{$HOME}", "{}{", "a { b } c"]) {
      expect(rendered(text), text).toBe(text);
    }
  });
});

describe("105-S77: a trigger whose event names no file", () => {
  it("refuses rather than substituting an empty string", () => {
    const reason = refusal("Read {path}.", null);
    expect(reason).toContain("names no file");
    expect(reason).toContain("{path}");
  });

  it("still renders a prompt that never asked for one", () => {
    expect(rendered("Check in.", null)).toBe("Check in.");
  });

  it("says the unit is spent, because a claim is terminal", () => {
    // The work is consumed whatever happens next, so a refusal that read like a
    // retry would be a lie about what it cost.
    expect(refusal("{path}", null)).toContain("spent");
    expect(refusal("{nope}")).toContain("spent");
  });
});

describe("the recognised set is one table", () => {
  it("names exactly path, id, due and mentions", () => {
    expect(placeholderNames()).toEqual(["due", "id", "mentions", "path"]);
    expect(Object.keys(PLACEHOLDERS).sort()).toEqual(["due", "id", "mentions", "path"]);
  });

  it("does not answer for a name inherited from Object.prototype", () => {
    // `{constructor}` and `{toString}` are on every object; a lookup that did
    // not ask hasOwnProperty would substitute a function into the prompt.
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const out = renderPrompt(`x {${name}} y`, file);
      expect(out.ok, name).toBe(false);
    }
  });
});

describe("185-S29: a schedule's prompt can say when the firing was due", () => {
  const due = "2026-10-19T09:00+02:00";

  it("substitutes {due} with the local time and its offset", () => {
    const out = renderPrompt("Do your rounds. This round was due at {due}.", { file: null, due });
    expect(out).toEqual({ ok: true, prompt: "Do your rounds. This round was due at 2026-10-19T09:00+02:00." });
  });

  it("refuses {due} on an event that is not a schedule's, and spends the unit saying so", () => {
    const out = renderPrompt("Due {due}.", file);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("{due}");
      expect(out.reason).toContain("not a schedule's");
      expect(out.reason).toContain("spent");
    }
  });

  it("refuses {path} on a schedule's event, which names no file", () => {
    const out = renderPrompt("Read {path}.", { file: null, due });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("names no file");
  });

  it("lists every name when one is unknown", () => {
    const out = renderPrompt("{nope}", { file: null, due });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("{due}, {id}, {mentions} and {path}");
  });
});

describe("a mention trigger's prompt can say which mentions this wake-up stands for", () => {
  const thread = { thread: "t-a", comments: ["c-1", "c-2", "c-3"], count: 3 };

  it("195-S14: renders a thread unit as a sentence naming the thread and its three comments", () => {
    const out = renderPrompt("Answer these. {mentions}", { file: null, mentions: thread });
    expect(out).toEqual({
      ok: true,
      prompt: "Answer these. 3 mentions on thread `t-a`: comments `c-1`, `c-2` and `c-3`.",
    });
  });

  it("195-S14: one mention is said in the singular", () => {
    const out = renderPrompt("{mentions}", { file: null, mentions: { thread: "t-a", comments: ["c-1"], count: 1 } });
    expect(out).toEqual({ ok: true, prompt: "1 mention on thread `t-a`: comment `c-1`." });
  });

  it("195-S13: past the cap, says how many more there are than it lists", () => {
    const comments = Array.from({ length: 50 }, (_, i) => `c-${i}`);
    const out = renderPrompt("{mentions}", { file: null, mentions: { thread: "t-a", comments, count: 62 } });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.prompt.startsWith("62 mentions on thread `t-a`: comments `c-0`, `c-1`,")).toBe(true);
      expect(out.prompt.endsWith("`c-49` and 12 more on the same thread.")).toBe(true);
    }
  });

  it("195-S15: renders a document unit as the document's path and id", () => {
    const document = { id: "9f1e-4d2c", path: "04-specs/80-events.md" };
    expect(renderPrompt("{mentions}", { file: null, mentions: { document, count: 1 } })).toEqual({
      ok: true,
      prompt: "A mention in `04-specs/80-events.md` (`9f1e-4d2c`).",
    });
    expect(renderPrompt("{mentions}", { file: null, mentions: { document, count: 2 } })).toEqual({
      ok: true,
      prompt: "2 mentions in `04-specs/80-events.md` (`9f1e-4d2c`).",
    });
  });

  it("195-S16: a unit that carries no manifest renders the fallback sentence and is not refused", () => {
    for (const context of [{ file: null }, { file: null, mentions: null }, null]) {
      const out = renderPrompt("Answer every unanswered mention. {mentions}", context);
      expect(out, JSON.stringify(context)).toEqual({
        ok: true,
        prompt: `Answer every unanswered mention. ${MENTIONS_NOT_RECORDED}`,
      });
    }
    expect(MENTIONS_NOT_RECORDED).toBe(
      "The mentions this wake-up stands for were not recorded; read them with `list_mentions`.",
    );
  });

  it("substitutes in one pass, so an id that looks like a placeholder is not re-read", () => {
    const out = renderPrompt("{mentions}", { file: null, mentions: { thread: "{path}", comments: [], count: 1 } });
    expect(out).toEqual({ ok: true, prompt: "1 mention on thread `{path}`." });
  });
});
