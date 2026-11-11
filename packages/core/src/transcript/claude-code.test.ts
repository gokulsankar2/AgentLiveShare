import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, isEchoTool, parseTranscriptLines } from "./claude-code.js";
import type { AgentEvent } from "./events.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/transcripts/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);

const ofKind = <K extends AgentEvent["kind"]>(events: AgentEvent[], kind: K) =>
  events.filter((e): e is Extract<AgentEvent, { kind: K }> => e.kind === kind);

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: "2026-11-11T10:00:00Z",
  sessionId: "s",
  message: { role: "assistant", content, stop_reason: "tool_use" },
  ...extra,
});
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: "2026-11-11T10:00:01Z",
  sessionId: "s",
  message: { role: "user", content },
  ...extra,
});

describe("ClaudeCodeAdapter", () => {
  it("never throws on junk input and counts unknown entry types", () => {
    const a = new ClaudeCodeAdapter();
    for (const junk of [null, 42, "str", [], { type: "brand-new" }, { message: 5 }]) {
      expect(a.parseLine(junk)).toEqual([]);
    }
    expect(a.stats.unknownTypes).toMatchObject({ "brand-new": 1, "<missing>": 1 });
  });

  it("maps user prompts from string and text-block content", () => {
    const a = new ClaudeCodeAdapter();
    expect(ofKind(a.parseLine(user("hello there")), "user_prompt")[0]?.text).toBe("hello there");
    const blocks = a.parseLine(user([{ type: "text", text: "from blocks" }]));
    expect(ofKind(blocks, "user_prompt")[0]?.text).toBe("from blocks");
  });

  it("drops meta, interrupt, task-notification and auto-continuation user lines", () => {
    const a = new ClaudeCodeAdapter();
    const lines = [
      user("skill body", { isMeta: true }),
      user([{ type: "text", text: "[Request interrupted by user]" }]),
      user("<task-notification>…", { origin: { kind: "task-notification" } }),
      user("continue", { turnOrigin: "auto_continuation" }),
    ];
    for (const l of lines) expect(ofKind(a.parseLine(l), "user_prompt")).toEqual([]);
  });

  it("emits file_edit for Edit/Write/MultiEdit/NotebookEdit and attributes tool results", () => {
    const a = new ClaudeCodeAdapter();
    const events = [
      ...a.parseLine(
        assistant([{ type: "tool_use", id: "1", name: "Edit", input: { file_path: "/r/a.ts" } }]),
      ),
      ...a.parseLine(
        assistant([
          {
            type: "tool_use",
            id: "2",
            name: "NotebookEdit",
            input: { notebook_path: "/r/n.ipynb" },
          },
        ]),
      ),
      ...a.parseLine(user([{ type: "tool_result", tool_use_id: "1", content: "ok" }])),
      ...a.parseLine(
        user([{ type: "tool_result", tool_use_id: "2", content: "bad", is_error: true }]),
      ),
    ];
    expect(ofKind(events, "file_edit").map((e) => e.path)).toEqual(["/r/a.ts", "/r/n.ipynb"]);
    expect(ofKind(events, "tool_result")).toMatchObject([{ tool: "Edit", id: "1" }]);
    expect(ofKind(events, "tool_error")).toMatchObject([{ tool: "NotebookEdit", id: "2" }]);
    expect(ofKind(events, "user_prompt")).toEqual([]);
  });

  it("echo filter: als-mcp results never become errors or prompts", () => {
    const a = new ClaudeCodeAdapter();
    a.parseLine(
      assistant([{ type: "tool_use", id: "m", name: "mcp__als-mcp__get_team_status", input: {} }]),
    );
    const events = a.parseLine(
      user([{ type: "tool_result", tool_use_id: "m", content: "teammate card", is_error: true }]),
    );
    expect(events.map((e) => e.kind)).toEqual(["tool_result"]);
    expect(isEchoTool("mcp__als__check_conflicts")).toBe(true);
    expect(isEchoTool("mcp__plugin_als_als-mcp__post_note")).toBe(true);
    expect(isEchoTool("mcp__also__thing")).toBe(false);
  });

  it("tracks TodoWrite and the desktop plan tool's incremental ops", () => {
    const a = new ClaudeCodeAdapter();
    const plan = (input: unknown) =>
      ofKind(
        a.parseLine(
          assistant([{ type: "tool_use", id: "p", name: "mcp__ccd_turn__update_plan", input }]),
        ),
        "todos",
      )[0]?.items;
    expect(
      plan({
        items: [
          { content: "A", status: "in_progress" },
          { content: "B", status: "pending" },
          { content: "C", status: "pending" },
        ],
      }),
    ).toEqual([
      { text: "A", state: "in_progress" },
      { text: "B", state: "pending" },
      { text: "C", state: "pending" },
    ]);
    expect(plan({ advance: true })?.map((t) => t.state)).toEqual([
      "done",
      "in_progress",
      "pending",
    ]);
    expect(plan({ done: [2], start: 3 })?.map((t) => t.state)).toEqual([
      "done",
      "done",
      "in_progress",
    ]);
    expect(plan({ advance: false })).toBeUndefined();

    const todo = a.parseLine(
      assistant([
        {
          type: "tool_use",
          id: "t",
          name: "TodoWrite",
          input: { todos: [{ content: "X", status: "completed" }, { bogus: 1 }] },
        },
      ]),
    );
    expect(ofKind(todo, "todos")[0]?.items).toEqual([{ text: "X", state: "done" }]);
  });

  it("emits turn_end only for main-thread end_turn, and compaction markers", () => {
    const a = new ClaudeCodeAdapter();
    const end = assistant([{ type: "text", text: "done" }]);
    end.message.stop_reason = "end_turn";
    expect(ofKind(a.parseLine(end), "turn_end")).toHaveLength(1);
    expect(ofKind(a.parseLine({ ...end, isSidechain: true }), "turn_end")).toHaveLength(0);
    expect(
      ofKind(
        a.parseLine({
          type: "system",
          subtype: "compact_boundary",
          timestamp: "t",
          sessionId: "s",
        }),
        "compaction",
      ),
    ).toHaveLength(1);
    expect(
      ofKind(a.parseLine(user("summary…", { isCompactSummary: true })), "compaction"),
    ).toHaveLength(1);
  });

  it("emits session_meta only when sessionId/cwd/gitBranch change", () => {
    const a = new ClaudeCodeAdapter();
    const meta = (l: unknown) => ofKind(a.parseLine(l), "session_meta");
    expect(meta(user("x", { cwd: "/r", gitBranch: "main" }))).toHaveLength(1);
    expect(meta(user("y", { cwd: "/r", gitBranch: "main" }))).toHaveLength(0);
    expect(meta(user("z", { cwd: "/r", gitBranch: "feat" }))[0]?.gitBranch).toBe("feat");
  });
});

describe("golden: real and synthetic transcripts", () => {
  it("synthetic CLI transcript: tolerant of unknown types and malformed lines", () => {
    const { events, stats } = parseTranscriptLines(fixture("synthetic-cli.jsonl"));
    expect(stats.malformedLines).toBe(1);
    expect(stats.unknownTypes).toEqual({ "future-entry-type": 1 });
    expect(ofKind(events, "user_prompt").map((e) => [e.sidechain, e.text.slice(0, 20)])).toEqual([
      [false, "<system-reminder>\nIn"],
      [true, "Subagent: search the"],
      [false, "ok"],
    ]);
    expect(ofKind(events, "file_edit").map((e) => e.path)).toEqual([
      "/home/dev/project/src/auth/refresh.ts",
      "/etc/hosts",
      "/home/dev/project/src/auth/refresh.test.ts",
      "src/auth/middleware.ts",
    ]);
    expect(ofKind(events, "tool_error").map((e) => e.tool)).toEqual(["Bash", "Bash", "Bash"]);
    expect(ofKind(events, "todos")).toHaveLength(2);
    expect(ofKind(events, "turn_end")).toHaveLength(1);
  });

  it("real Claude Code 2.1.321 desktop transcript parses with no unknown types", () => {
    const { events, stats } = parseTranscriptLines(fixture("cc-2.1.321-scaffold.jsonl"));
    expect(stats.malformedLines).toBe(0);
    expect(stats.unknownTypes).toEqual({});
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    expect(counts).toMatchSnapshot();
    expect(ofKind(events, "file_edit").length).toBeGreaterThan(10);
    expect(ofKind(events, "todos").length).toBeGreaterThan(0);
  });
});
