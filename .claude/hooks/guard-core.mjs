#!/usr/bin/env node
// PreToolUse guard: keeps the agent out of human-owned core directories.
// Tests, fixtures and snapshots stay writable. See CLAUDE.md "Ownership rules".
// Exit 2 blocks the tool call and feeds stderr back to the agent.

const OWNED = /packages\/core\/src\/(redact|distill|sync)\//;
const ALLOWED =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/)|(\/__fixtures__\/)|(\/__snapshots__\/)/;
// Shell writes: a redirect aimed at an owned path, or a file-mutating command mentioning one.
const SHELL_REDIRECT = />>?\s*["']?[^\s"']*packages\/core\/src\/(redact|distill|sync)\//;
const SHELL_MUTATE =
  /(\btee\b|\bsed\s+-i|\bperl\s+-[a-z]*i|\bmv\b|\bcp\b|\brm\b|\btouch\b|\bpatch\b|\bgit\s+(checkout|restore|apply)\b)/;

function block(reason) {
  process.stderr.write(
    `Blocked by guard-core: ${reason}\n` +
      "packages/core/src/{redact,distill,sync} is human-owned (see CLAUDE.md). " +
      "Write tests/fixtures, review, or explain instead. Ask the user if you need an exception.\n",
  );
  process.exit(2);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // malformed hook input: don't wedge the session
  }
  const tool = input.tool_name ?? "";
  const args = input.tool_input ?? {};

  if (tool === "Bash") {
    const cmd = String(args.command ?? "");
    if (SHELL_REDIRECT.test(cmd) || (OWNED.test(cmd) && SHELL_MUTATE.test(cmd))) {
      block("shell command appears to write into an owned directory");
    }
    process.exit(0);
  }

  const path = String(args.file_path ?? args.notebook_path ?? "").replaceAll("\\", "/");
  if (OWNED.test(path) && !ALLOWED.test(path)) {
    block(`${tool} on ${path}`);
  }
  process.exit(0);
});
