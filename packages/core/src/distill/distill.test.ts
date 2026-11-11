import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentCard } from "../schema.js";
import { parseTranscriptLines } from "../transcript/claude-code.js";
import type { AgentEvent } from "../transcript/events.js";
import {
  buildTier1Card,
  type CardContext,
  statusFrom,
  toRepoRelative,
  truncateWithMarker,
} from "./card.js";
import { foldEvents } from "./facts.js";
import { cleanPrompt, firstSentence, isSubstantive } from "./text.js";

// docs/ARCHITECTURE.md §2.2. Fixtures in fixtures/transcripts/.

const T0 = Date.parse("2026-11-11T10:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const meta = (sec = 0): AgentEvent => ({
  kind: "session_meta",
  sessionId: "7f3a9c1e-0000-4000-8000-000000000000",
  cwd: "/repo",
  gitBranch: "feat/x",
  ts: at(sec),
});
const prompt = (text: string, sec: number, sidechain = false): AgentEvent => ({
  kind: "user_prompt",
  text,
  sidechain,
  ts: at(sec),
});
const edit = (path: string, sec: number): AgentEvent => ({
  kind: "file_edit",
  path,
  tool: "Edit",
  ts: at(sec),
});
const ctx = (nowSec: number, extra: Partial<CardContext> = {}): CardContext => ({
  login: "dev",
  head: "abc1234",
  now: new Date(T0 + nowSec * 1000),
  ...extra,
});
const card = (events: AgentEvent[], nowSec = 60, extra: Partial<CardContext> = {}) =>
  buildTier1Card(foldEvents([meta(), ...events]), ctx(nowSec, extra));

describe("distill: Tier 1 — intent", () => {
  it("uses the first substantive user prompt as intent", () => {
    const c = card([
      prompt("Add refresh-token rotation to the auth middleware", 1),
      prompt("Also make sure the middleware rotation handles expiry", 2),
    ]);
    expect(c.intent).toBe("Add refresh-token rotation to the auth middleware");
  });

  it("skips prompts under 20 chars and acknowledgements (yes, ok, continue, go, y)", () => {
    for (const p of [
      "fix it",
      "yes, go ahead and do all of that",
      "ok sounds good to me then",
      "Continue with the plan please",
    ]) {
      expect(isSubstantive(cleanPrompt(p))).toBe(false);
    }
    expect(card([prompt("ok", 1), prompt("Yes, set it up for the whole repo", 2)]).intent).toBe("");
    for (const p of [
      "Go through src/auth and add rate limiting",
      "Yes, and also add retries to the API client",
    ]) {
      expect(isSubstantive(cleanPrompt(p))).toBe(true);
    }
  });

  it("strips injected blocks (<system-reminder>, <command-name>, pasted-content tags)", () => {
    const raw =
      "<system-reminder>secret ctx</system-reminder><command-name>/review</command-name>" +
      "<command-args>Review the redaction module for bypasses</command-args>" +
      '<pasted_content id="x">huge log</pasted_content><bash-input>ls</bash-input>';
    expect(cleanPrompt(raw)).toBe("Review the redaction module for bypasses");
    expect(cleanPrompt('Fix this <pasted_content id="1">unterminated')).toBe("Fix this");
  });

  it("takes the Task: section of a session hand-off preamble", () => {
    const raw =
      "Background (from the session that started this one):\nLots of context.\n\nTask:\nBuild the Week 1 slice.\n\nMore.";
    expect(firstSentence(cleanPrompt(raw))).toBe("Build the Week 1 slice.");
  });

  it("replaces intent when a later prompt starts a new topic", () => {
    const c = card([
      prompt("Add refresh-token rotation to the auth middleware", 1),
      edit("/repo/src/auth/middleware.ts", 2),
      prompt("Now migrate the billing invoices table to postgres with zero downtime", 3),
    ]);
    expect(c.intent).toBe("Now migrate the billing invoices table to postgres with zero downtime");
    const same = card([
      prompt("Add refresh-token rotation to the auth middleware", 1),
      prompt(
        "The rotation in the auth middleware should also handle expired refresh tokens gracefully",
        2,
      ),
    ]);
    expect(same.intent).toBe("Add refresh-token rotation to the auth middleware");
  });

  it("truncates to the first sentence, max 200 chars", () => {
    expect(firstSentence("# Title\nContext:\n- Do the thing now. Then more.")).toBe(
      "Do the thing now.",
    );
    const long = `Please ${"really ".repeat(60)}refactor.`;
    const c = card([prompt(long, 1)]);
    expect(c.intent.length).toBe(200);
    expect(c.intent.endsWith("…")).toBe(true);
  });

  it("ignores isSidechain (subagent) prompts for intent", () => {
    expect(card([prompt("Subagent: search the whole codebase for usages", 1, true)]).intent).toBe(
      "",
    );
  });

  it("applies scrub before truncating, so a secret is never cut in half", () => {
    const secret = `Use key ${"Z".repeat(300)} for the deploy`;
    const c = card([prompt(secret, 1)], 60, { scrub: (s) => s.replace(/Z{20,}/g, "[REDACTED:x]") });
    expect(c.intent).toBe("Use key [REDACTED:x] for the deploy");
  });
});

describe("distill: Tier 1 — tasks and files", () => {
  it("takes tasks from the latest todo-tool input via the tool-name map", () => {
    const c = card([
      { kind: "todos", items: [{ text: "A", state: "pending" }], ts: at(1) },
      {
        kind: "todos",
        items: [
          { text: "A", state: "done" },
          { text: "B", state: "in_progress" },
        ],
        ts: at(2),
      },
    ]);
    expect(c.tasks).toEqual([
      { text: "A", state: "done" },
      { text: "B", state: "in_progress" },
    ]);
    expect(c.summary).toBe("1/2 tasks done.");
  });

  it("collects files.modified from Edit/Write/MultiEdit/NotebookEdit, most recent first", () => {
    const c = card([edit("/repo/a.ts", 1), edit("/repo/b.ts", 2), edit("/repo/a.ts", 3)]);
    expect(c.files.modified).toEqual(["a.ts", "b.ts"]);
  });

  it("makes paths repo-relative and drops paths outside the repo", () => {
    expect(toRepoRelative("/repo/src/x.ts", "/repo", "/repo")).toBe("src/x.ts");
    expect(toRepoRelative("src/x.ts", "/repo", "/repo/pkg")).toBe("pkg/src/x.ts");
    expect(toRepoRelative("/etc/hosts", "/repo", "/repo")).toBeUndefined();
    expect(toRepoRelative("/repo/../repo2/x", "/repo", "/repo")).toBeUndefined();
    expect(toRepoRelative("/repo", "/repo", "/repo")).toBeUndefined();
    expect(toRepoRelative("/repo/..foo/x.ts", "/repo", "/repo")).toBe("..foo/x.ts");
    const c = card([edit("/etc/hosts", 1), edit("../outside.ts", 2), edit("/repo/in.ts", 3)]);
    expect(c.files.modified).toEqual(["in.ts"]);
  });

  it("keeps subagent (sidechain) file edits", () => {
    const { events } = parseTranscriptLines(fixtureLines("synthetic-cli.jsonl"));
    const facts = foldEvents(events);
    expect(facts.edits.map((e) => e.path)).toContain("/home/dev/project/src/auth/refresh.test.ts");
  });

  it("files.inProgress = files edited in the last 5 minutes (injected clock)", () => {
    const c = card([edit("/repo/old.ts", 0), edit("/repo/new.ts", 200)], 400);
    expect(c.files.modified).toEqual(["new.ts", "old.ts"]);
    expect(c.files.inProgress).toEqual(["new.ts"]);
  });

  it("caps files.modified at 15 entries with a '+N more' marker", () => {
    const edits = Array.from({ length: 20 }, (_, i) => edit(`/repo/f${i}.ts`, i));
    const c = card(edits);
    expect(c.files.modified).toHaveLength(15);
    expect(c.files.modified[0]).toBe("f19.ts");
    expect(c.files.modified[14]).toBe("+6 more");
    expect(truncateWithMarker(["a", "b", "+3 more"], 2)).toEqual(["a", "+4 more"]);
    expect(truncateWithMarker(["a", "b"], 2)).toEqual(["a", "b"]);
  });
});

describe("distill: Tier 1 — status, blockers, git", () => {
  const facts = (events: AgentEvent[]) => foldEvents([meta(), ...events]);
  const now = (sec: number) => new Date(T0 + sec * 1000);

  it("status = active when the last event is a tool_use without a result", () => {
    expect(
      statusFrom(facts([{ kind: "tool_use", tool: "Bash", id: "1", ts: at(1) }]), now(10)),
    ).toBe("active");
  });

  it("status = waiting_on_user after turn_end with no newer user prompt", () => {
    const f = facts([
      prompt("Do the substantive thing please", 1),
      { kind: "turn_end", ts: at(2) },
    ]);
    expect(statusFrom(f, now(10))).toBe("waiting_on_user");
    const resumed = foldEvents([prompt("And now the next substantive thing", 3)], f);
    expect(statusFrom(resumed, now(10))).toBe("active");
  });

  it("status = idle after 5 min without writes, ended after 30 min", () => {
    const f = facts([{ kind: "turn_end", ts: at(0) }]);
    expect(statusFrom(f, now(299))).toBe("waiting_on_user");
    expect(statusFrom(f, now(300))).toBe("idle");
    expect(statusFrom(f, now(1800))).toBe("ended");
    const longRun = facts([{ kind: "tool_use", tool: "Bash", id: "b", ts: at(0) }]);
    expect(statusFrom(longRun, now(900))).toBe("active"); // pending tool call, e.g. a long build
    expect(statusFrom(longRun, now(1800))).toBe("ended");
  });

  it("ignores results whose tool_use was never seen (resumed mid-session)", () => {
    const orphan = (sec: number): AgentEvent => ({
      kind: "tool_error",
      tool: "unknown",
      id: `o${sec}`,
      ts: at(sec),
    });
    expect(card([orphan(1), orphan(2), orphan(3)]).blockers).toEqual([]);
  });

  it("adds a blocker after ≥3 errors from the same tool in the last 10 tool results", () => {
    const err = (sec: number): AgentEvent => ({
      kind: "tool_error",
      tool: "Bash",
      id: `${sec}`,
      ts: at(sec),
    });
    expect(card([err(1), err(2)]).blockers).toEqual([]);
    expect(card([err(1), err(2), err(3)]).blockers).toEqual(["Repeated Bash failures"]);
    const ok = (sec: number): AgentEvent => ({
      kind: "tool_result",
      tool: "Edit",
      id: `${sec}`,
      ts: at(sec),
    });
    const pushedOut = [err(1), err(2), err(3), ...Array.from({ length: 8 }, (_, i) => ok(4 + i))];
    expect(card(pushedOut).blockers).toEqual([]);
  });

  it("takes git.branch from the transcript's gitBranch field", () => {
    expect(card([]).git).toEqual({ branch: "feat/x", head: "abc1234" });
  });
});

describe("distill: echo filter", () => {
  it("drops tool_results from als-mcp tools so teammate cards are never republished", () => {
    const { events } = parseTranscriptLines(fixtureLines("synthetic-cli.jsonl"));
    const c = buildTier1Card(foldEvents(events), {
      login: "dev",
      head: "abc1234",
      now: new Date("2026-11-11T10:07:00Z"),
    });
    const json = JSON.stringify(c);
    expect(json).not.toContain("billing");
    expect(c.blockers).toEqual(["Repeated Bash failures"]); // the als-mcp error isn't counted
  });
});

describe("distill: golden cards", () => {
  const cases = [
    { name: "synthetic-cli", repoRoot: "/home/dev/project" },
    { name: "cc-2.1.321-scaffold", repoRoot: "/home/dev/Desktop/Projects/AgentLiveShare" },
  ];
  for (const { name, repoRoot } of cases) {
    it(`${name}.jsonl → ${name}.expected.json`, () => {
      const { events } = parseTranscriptLines(fixtureLines(`${name}.jsonl`));
      const facts = foldEvents(events);
      const now = new Date(Date.parse(facts.lastEventAt ?? "") + 60_000);
      const c = buildTier1Card(facts, { login: "dev", head: "abc1234", repoRoot, now });
      expect(AgentCard.safeParse(c).success).toBe(true);
      const expectedUrl = fixtureUrl(`${name}.expected.json`);
      if (process.env.UPDATE_GOLDEN || !existsSync(expectedUrl)) {
        writeFileSync(expectedUrl, `${JSON.stringify(c, null, 2)}\n`);
      }
      expect(c).toEqual(JSON.parse(readFileSync(expectedUrl, "utf8")));
    });
  }
});

describe("distill: Tier 2 — optional Haiku summary", () => {
  it.todo("triggers on a new user prompt, a todo change, or 10 new file edits");
  it.todo("runs at most once per 3 minutes per session; otherwise reuses the last summary");
  it.todo("sends only redacted input: previous card, Tier-1 facts, last 3 prompts, last 2 replies");
  it.todo("validates model output with zod and falls back to Tier 1 on failure or 8s timeout");
  it.todo("records meta.distillTier (2 on success, 1 on fallback)");
});

// Budgeter tests live in budget.test.ts.

function fixtureUrl(name: string): URL {
  return new URL(`../../../../fixtures/transcripts/${name}`, import.meta.url);
}
function fixtureLines(name: string): string[] {
  return readFileSync(fixtureUrl(name), "utf8").split("\n").filter(Boolean);
}
