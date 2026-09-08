import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/main.ts";

describe("the version the binary reports", () => {
  it("109-S4: is the version package.json declares", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
