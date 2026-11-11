#!/usr/bin/env node
import { MAX_CARD_BYTES } from "@als/core";

const USAGE = `Usage: als <command> [args]

Commands:
  distill <transcript.jsonl>   Print the redacted card for a Claude Code transcript (≤${MAX_CARD_BYTES} bytes)
  check <path>                 Warn if a teammate's agent is editing or has claimed <path>
`;

function notImplemented(command: string): number {
  process.stderr.write(`als ${command}: not implemented yet\n`);
  return 1;
}

function main(argv: string[]): number {
  const [command, arg] = argv;
  switch (command) {
    case "distill":
    case "check":
      if (!arg) {
        process.stderr.write(USAGE);
        return 2;
      }
      return notImplemented(command);
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

process.exitCode = main(process.argv.slice(2));
