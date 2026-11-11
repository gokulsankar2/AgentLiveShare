#!/usr/bin/env node
import { MAX_CARD_BYTES } from "@als/core";
import { DISTILL_USAGE, distillCommand } from "./distill.js";

const USAGE = `Usage: als <command> [args]

Commands:
  distill <transcript.jsonl>   Print the redacted card for a Claude Code transcript (≤${MAX_CARD_BYTES} bytes)
  check <path>                 Warn if a teammate's agent is editing or has claimed <path>

Run "als distill --help" for distill options.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "distill":
      if (rest.includes("-h") || rest.includes("--help")) {
        process.stdout.write(DISTILL_USAGE);
        return 0;
      }
      return distillCommand(rest);
    case "check":
      if (!rest[0]) {
        process.stderr.write(USAGE);
        return 2;
      }
      process.stderr.write("als check: not implemented yet\n");
      return 1;
    case undefined:
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`als: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
