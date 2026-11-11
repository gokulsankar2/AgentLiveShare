import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  ClaudeCodeAdapter,
  distillFacts,
  foldEvents,
  initialTailState,
  parseTranscriptLines,
  readNewLines,
  TARGET_CARD_BYTES,
} from "@als/core";

// `als distill <transcript.jsonl>` — the Week-1 deliverable (ARCHITECTURE.md §3).
//
// Owner login, in order: --login, $ALS_LOGIN, `git config github.user`,
// `gh api user` (the GitHub CLI's signed-in account). The daemon will use VS
// Code's GitHub session instead (week 3); the CLI has no auth of its own.
// HEAD: --head, else `git rev-parse --short HEAD` in the repo root.
// Repo root: --repo-root, else `git rev-parse --show-toplevel` from the
// transcript's cwd, else that cwd.

export const DISTILL_USAGE = `Usage: als distill <transcript.jsonl> [options]

Options:
  --login <login>     GitHub login for agentId/owner (default: $ALS_LOGIN, git config github.user, gh)
  --head <sha>        Commit sha for git.head (default: git rev-parse --short HEAD in the repo)
  --repo-root <dir>   Repo root for repo-relative paths (default: from the transcript's cwd)
  --now <iso>         Clock override, for reproducible output
  --json              Print the exact compact payload instead of pretty JSON
`;

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  /** Run a command without a shell; return trimmed stdout, or undefined on any failure. */
  exec: (cmd: string, args: string[], cwd?: string) => string | undefined;
}

export const defaultIo: Io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  exec: (cmd, args, cwd) => {
    try {
      return execFileSync(cmd, args, {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  },
};

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

function resolveLogin(flag: string | undefined, io: Io): string | undefined {
  const candidates = [
    () => flag,
    () => io.env.ALS_LOGIN,
    () => io.exec("git", ["config", "--get", "github.user"]),
    () => io.exec("gh", ["api", "user", "--jq", ".login"]),
  ];
  for (const get of candidates) {
    const v = get()?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * The transcript's cwd is untrusted input: git runs there with fsmonitor and
 * other config-driven helpers disabled, so a hostile repo can't run code.
 */
const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export async function distillCommand(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (err) {
    // Fail closed without a stack trace: messages could echo transcript content.
    io.stderr(`als distill: failed (${err instanceof Error ? err.name : "error"})\n`);
    return 1;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    io.stderr(`als distill: ${(err as Error).message}\n\n${DISTILL_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  if (!file || positionals.length > 1) {
    io.stderr(DISTILL_USAGE);
    return 2;
  }

  let lines: string[];
  let skippedLines: number;
  try {
    const read = await readNewLines(file, initialTailState());
    lines = read.lines;
    skippedLines = read.state.skippedLines;
  } catch (err) {
    io.stderr(
      `als distill: cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? "error"}\n`,
    );
    return 2;
  }

  const adapter = new ClaudeCodeAdapter();
  const { events, stats } = parseTranscriptLines(lines, adapter);
  const facts = foldEvents(events);

  const login = resolveLogin(values.login, io);
  if (!login || !LOGIN_RE.test(login)) {
    io.stderr(
      login
        ? "als distill: that is not a valid GitHub login\n"
        : "als distill: no GitHub login found; pass --login, set ALS_LOGIN, or sign in with `gh auth login`\n",
    );
    return 2;
  }

  const cwd = facts.cwd;
  const repoRoot =
    values["repo-root"] ??
    (cwd ? io.exec("git", [...SAFE_GIT, "rev-parse", "--show-toplevel"], cwd) : undefined) ??
    cwd;
  if (!repoRoot) {
    io.stderr("als distill: transcript has no cwd; pass --repo-root\n");
    return 2;
  }

  const head =
    values.head ?? io.exec("git", [...SAFE_GIT, "rev-parse", "--short", "HEAD"], repoRoot);
  if (!head || !SHA_RE.test(head)) {
    io.stderr("als distill: could not read git HEAD; pass --head <sha> (7–40 lowercase hex)\n");
    return 2;
  }

  const now = values.now ? new Date(values.now) : new Date();
  if ((values.now && !ISO_RE.test(values.now)) || Number.isNaN(now.getTime())) {
    io.stderr("als distill: --now must be an ISO-8601 timestamp\n");
    return 2;
  }

  const out = distillFacts(facts, { login, head, repoRoot, now });
  const unknown = Object.entries(stats.unknownTypes);
  if (unknown.length || stats.malformedLines || skippedLines) {
    const parts = [
      ...unknown.map(([t, n]) => `${t}×${n}`),
      stats.malformedLines ? `malformed×${stats.malformedLines}` : "",
      skippedLines ? `oversized×${skippedLines}` : "",
    ].filter(Boolean);
    io.stderr(`als distill: skipped lines: ${parts.join(", ")}\n`);
  }
  if (!out.ok) {
    io.stderr(`als distill: blocked, nothing printed: ${out.reason}\n`);
    return 1;
  }

  // Print the gated bytes themselves (pretty mode just re-indents them).
  io.stdout(values.json ? `${out.json}\n` : `${JSON.stringify(JSON.parse(out.json), null, 2)}\n`);
  io.stderr(
    `als distill: ${out.bytes} bytes (target ${TARGET_CARD_BYTES}), ` +
      `${out.redactions} redaction(s), ${events.length} events from ${stats.lines} lines` +
      (out.budgetSteps.length ? `, budget dropped: ${out.budgetSteps.join(" → ")}` : "") +
      "\n",
  );
  return 0;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      login: { type: "string" },
      head: { type: "string" },
      "repo-root": { type: "string" },
      now: { type: "string" },
      json: { type: "boolean" },
    },
  });
}
