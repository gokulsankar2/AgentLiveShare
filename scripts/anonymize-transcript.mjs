#!/usr/bin/env node
// Turn a real Claude Code transcript into a committable golden fixture.
// See fixtures/transcripts/README.md. Usage:
//   node scripts/anonymize-transcript.mjs <in.jsonl> <out.jsonl> \
//     --home /Users/alice --user alice --name "Alice Smith" --session 11111111-2222-3333-4444-555555555555
//
// What it does:
// - keeps user/assistant/system entries with a whitelist of fields
//   (drops thinking blocks, usage, request metadata, tool-result payloads);
// - keeps one stripped sample of every other entry type (format-drift coverage);
// - rewrites the home dir to /home/dev, the username to "dev", the session id,
//   and every email to dev@example.com; truncates long strings.
// Always grep the output before committing.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) {
  console.error(
    "usage: anonymize-transcript.mjs <in.jsonl> <out.jsonl> [--home H] [--user U] [--name N] [--session S]",
  );
  process.exit(2);
}
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, "")] = rest[i + 1];

const TEXT_MAX = 400;
const INPUT_MAX = 160;
const RESULT_MAX = 100;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const raw = readFileSync(input, "utf8");
const originalSession = raw.match(/"sessionId":"([0-9a-f-]{36})"/)?.[1];

function scrub(s, max) {
  let out = s;
  if (opts.session && originalSession) out = out.replaceAll(originalSession, opts.session);
  if (opts.home) out = out.replaceAll(opts.home, "/home/dev");
  out = out.replace(/\/Users\/[^/\s"']+/g, "/home/dev");
  if (opts.name) out = out.replace(new RegExp(escapeRe(opts.name), "gi"), "Dev User");
  if (opts.user) out = out.replace(new RegExp(escapeRe(opts.user), "gi"), "dev");
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "dev@example.com");
  if (out.length > max) out = `${out.slice(0, max)}…`;
  return out;
}

function scrubDeep(v, max) {
  if (typeof v === "string") return scrub(v, max);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, max));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, max)]));
  }
  return v;
}

function block(b) {
  if (!b || typeof b !== "object") return undefined;
  switch (b.type) {
    case "text":
      return { type: "text", text: scrub(b.text ?? "", TEXT_MAX) };
    case "tool_use":
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: scrubDeep(b.input ?? {}, INPUT_MAX),
      };
    case "tool_result": {
      const c = typeof b.content === "string" ? b.content : "[content omitted]";
      const out = {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: scrub(c, RESULT_MAX),
      };
      if (b.is_error) out.is_error = true;
      return out;
    }
    default:
      return undefined; // thinking, image, …
  }
}

const KEEP = [
  "type",
  "subtype",
  "isSidechain",
  "isMeta",
  "isCompactSummary",
  "turnOrigin",
  "timestamp",
  "cwd",
  "gitBranch",
  "version",
];
const seenOther = new Set();
const out = [];

for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const session = opts.session ?? e.sessionId;
  if (e.type === "user" || e.type === "assistant" || e.type === "system") {
    const o = {};
    for (const k of KEEP) if (k in e) o[k] = typeof e[k] === "string" ? scrub(e[k], 200) : e[k];
    if (e.origin?.kind) o.origin = { kind: e.origin.kind };
    o.sessionId = session;
    if (e.message) {
      const c = e.message.content;
      const content =
        typeof c === "string" ? scrub(c, TEXT_MAX) : (c ?? []).map(block).filter(Boolean);
      if (Array.isArray(content) && content.length === 0) continue;
      o.message = { role: e.message.role, content };
      if (e.message.stop_reason) o.message.stop_reason = e.message.stop_reason;
    }
    out.push(JSON.stringify(o));
  } else if (!seenOther.has(e.type)) {
    seenOther.add(e.type);
    const o = { type: e.type, sessionId: session };
    if (e.timestamp) o.timestamp = e.timestamp;
    if (e.type === "attachment" && e.attachment?.type) o.attachment = { type: e.attachment.type };
    out.push(JSON.stringify(o));
  }
}

writeFileSync(output, `${out.join("\n")}\n`);
console.error(`wrote ${out.length} entries to ${output}`);
