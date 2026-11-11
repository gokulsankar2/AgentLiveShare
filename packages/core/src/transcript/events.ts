// Normalized agent events — docs/ARCHITECTURE.md §2.1.
// Adapters turn tool-specific transcript lines into these; the Tier-1 extractor
// only ever sees AgentEvents, so adding Cursor/Codex means writing an adapter.

export type TaskItem = { text: string; state: "pending" | "in_progress" | "done" };

/** ISO-8601 timestamp string taken from the transcript line. */
type Ts = { ts: string };

export type AgentEvent =
  | ({ kind: "session_meta"; sessionId: string; cwd?: string; gitBranch?: string } & Ts)
  | ({ kind: "user_prompt"; text: string; sidechain: boolean } & Ts)
  | ({ kind: "assistant_text"; text: string; sidechain: boolean } & Ts)
  | ({ kind: "tool_use"; tool: string; id: string } & Ts)
  | ({ kind: "tool_result"; tool: string; id: string } & Ts)
  | ({ kind: "tool_error"; tool: string; id: string } & Ts)
  | ({ kind: "file_edit"; path: string; tool: string } & Ts)
  | ({ kind: "file_read"; path: string } & Ts)
  // Used for signals only; never synced.
  | ({ kind: "command"; cmd: string } & Ts)
  | ({ kind: "todos"; items: TaskItem[] } & Ts)
  | ({ kind: "turn_end" } & Ts)
  | ({ kind: "compaction" } & Ts);

export type AgentEventKind = AgentEvent["kind"];

export interface TranscriptAdapter {
  /** Map one parsed JSONL entry to zero or more events. Must never throw. */
  parseLine(raw: unknown): AgentEvent[];
}
