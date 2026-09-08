import { describe, it, expect } from "vitest";
import { PLACEHOLDERS, placeholderNames, renderPrompt } from "../src/run/prompt.ts";

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
  it("names exactly path and id", () => {
    expect(placeholderNames()).toEqual(["id", "path"]);
    expect(Object.keys(PLACEHOLDERS).sort()).toEqual(["id", "path"]);
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
