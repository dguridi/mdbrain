// The command registry, the argument parser and the help renderer.
//
// Commands are data, not code paths: one declaration carries a subcommand's
// flags, its summary and its handler, and both the dispatcher and `--help` are
// derived from it. That is what keeps the help honest — the CLI is the whole
// surface of this program, so an undocumented subcommand is an unreachable one,
// and there is deliberately no second place to remember to update.

export interface FlagSpec {
  name: string;
  summary: string;
  /** Whether the flag consumes the following argument. */
  takesValue?: boolean;
}

export interface CommandSpec {
  name: string;
  summary: string;
  /** Rendered after the name in help, e.g. `<agent>`. */
  usage?: string;
  flags?: FlagSpec[];
  run(context: CommandContext): Promise<number>;
}

export interface CommandContext {
  positional: string[];
  flags: Record<string, string | boolean>;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface ParsedArgv {
  command: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Splits argv into a command, its flags and its positional arguments.
 *
 * A flag only consumes the next word when the command being run declares it as
 * taking a value, so `runner --once` does not swallow whatever follows it.
 */
export function parseArgv(argv: string[], valueFlags: Set<string> = new Set()): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.replace(/^--?/, "").split(/=(.*)/s);
    if (inline !== undefined) {
      flags[name] = inline;
    } else if (valueFlags.has(name) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) {
      flags[name] = argv[++i];
    } else {
      flags[name] = true;
    }
  }

  return { command: positional.length > 0 ? positional[0] : null, positional: positional.slice(1), flags };
}

/**
 * Renders `--help` from the registry.
 *
 * Every registered command appears, with its flags, because the test that guards
 * this reads the same registry: a command added without a summary shows up as a
 * gap rather than as an omission nobody notices.
 */
export function renderHelp(commands: CommandSpec[], version: string): string {
  const width = Math.max(...commands.map((c) => `${c.name} ${c.usage ?? ""}`.trim().length));
  const lines = [
    `mdbrain ${version} — sign in to markdown-den from the command line`,
    "",
    "Usage: mdbrain <command> [options]",
    "",
    "Commands:",
  ];
  for (const command of commands) {
    const label = `${command.name} ${command.usage ?? ""}`.trim();
    lines.push(`  ${label.padEnd(width)}  ${command.summary}`);
    for (const flag of command.flags ?? []) {
      lines.push(`  ${" ".repeat(width)}    --${flag.name.padEnd(16)} ${flag.summary}`);
    }
  }
  lines.push("", "Run `mdbrain <command> --help` for a command's own options.");
  return lines.join("\n");
}

/**
 * Dispatches one invocation.
 *
 * @returns the process exit code — 0 for success, 1 for a user-visible failure,
 * 2 for an unknown command, which is a distinction a script wrapping this cares
 * about even though a person reading the message does not.
 */
export async function dispatch(
  argv: string[],
  commands: CommandSpec[],
  version: string,
  io: { out: (line: string) => void; err: (line: string) => void },
): Promise<number> {
  const first = parseArgv(argv);

  // Asked before the bare-invocation branch below, which would otherwise swallow
  // `--version` — it carries no command, and so looks like an empty invocation.
  if (first.flags.version === true || first.flags.v === true) {
    io.out(version);
    return 0;
  }
  // Only a *bare* --help prints the whole registry. With a command in front of
  // it the help belongs to that command, which is what the footer of this very
  // output tells people to ask for.
  if (first.command === null) {
    io.out(renderHelp(commands, version));
    return 0;
  }

  const command = commands.find((c) => c.name === first.command);
  if (!command) {
    io.err(`Unknown command "${first.command}".`);
    io.out(renderHelp(commands, version));
    return 2;
  }

  const valueFlags = new Set((command.flags ?? []).filter((f) => f.takesValue).map((f) => f.name));
  const parsed = parseArgv(argv, valueFlags);

  if (parsed.flags.help === true || parsed.flags.h === true) {
    io.out(renderHelp([command], version));
    return 0;
  }

  return command.run({ positional: parsed.positional, flags: parsed.flags, out: io.out, err: io.err });
}
