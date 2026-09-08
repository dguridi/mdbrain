import { defineConfig } from "vitest/config";

// The runner's own tests. Node environment, no DOM and no database: the pure
// decision core and the config layer are the bulk of them, and the few that
// spawn a process spawn `node` rather than anything this repo ships.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
