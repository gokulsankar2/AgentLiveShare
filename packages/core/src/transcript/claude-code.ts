import type { AgentEvent, TaskItem, TranscriptAdapter } from "./events.js";

// Claude Code adapter — docs/ARCHITECTURE.md §2.1.
// The JSONL format is undocumented and drifts between versions, so every
// access is defensive: unknown entry types, block types and tool inputs are
// counted and ignored, never thrown.

/** Tools whose `file_path` / `notebook_path` input is a file write. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/** Todo/plan tools, mapped to a parser for their input (tool-name map, §2.2). */
type TodoParser = (input: Record<string, unknown>, previous: TaskItem[]) => TaskItem[] | undefined;

const STATE_MAP: Record<string, TaskItem["state"]> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "done",
  done: "done",
};

function parseItems(list: unknown, textKey: string): TaskItem[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const items: TaskItem[] = [];
  for (const it of list) {
    if (!isRecord(it)) continue;
    const text = it[textKey];
    const state = STATE_MAP[String(it.status)];
    if (typeof text === "string" && text.trim() && state) items.push({ text: text.trim(), state });
  }
  return items;
}

/**
 * The desktop app's plan tool sends either a whole list (`items`) or an
 * incremental op (`advance`, or `done`/`start` with 1-based indexes).
 */
function parseUpdatePlan(input: Record<string, unknown>, previous: TaskItem[]) {
  const full = parseItems(input.items, "content");
  if (full) return full;
  const next = previous.map((t) => ({ ...t }));
  let changed = false;
  if (input.advance === true) {
    const cur = next.findIndex((t) => t.state === "in_progress");
    const current = next[cur];
    if (current) current.state = "done";
    const after = next.find((t, i) => i > cur && t.state === "pending");
    if (after) after.state = "in_progress";
    changed = current !== undefined || after !== undefined;
  }
  if (Array.isArray(input.done)) {
    for (const n of input.done) {
      const t = typeof n === "number" ? next[n - 1] : undefined;
      if (t) {
        t.state = "done";
        changed = true;
      }
    }
  }
  if (typeof input.start === "number") {
    const t = next[input.start - 1];
    if (t) {
      t.state = "in_progress";
      changed = true;
    }
  }
  return changed ? next : undefined;
}

export const TODO_TOOLS: Readonly<Record<string, TodoParser>> = {
  TodoWrite: (input) => parseItems(input.todos, "content"),
  mcp__ccd_turn__update_plan: parseUpdatePlan,
};

/**
 * Agent Live Share's own MCP tools. Their results are teammate cards; if we
 * distilled them, our card would republish a teammate's state (echo loop, §2.2).
 */
export function isEchoTool(name: string): boolean {
  return /^mcp__(?:plugin_[\w-]+_)?als(?:[-_]mcp)?__/.test(name);
}

/** User-role text that is harness noise, not something the human asked for. */
const NON_PROMPT_TEXT = /^\[Request interrupted by user[^\]]*\]$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export interface AdapterStats {
  lines: number;
  /** Entry `type`s we don't map (counted so drift shows up in the UI). */
  unknownTypes: Record<string, number>;
}

/** Entry types we know about and deliberately produce no events for. */
const IGNORED_TYPES = new Set([
  "attachment",
  "summary",
  "queue-operation",
  "last-prompt",
  "custom-title",
  "ai-title",
  "agent-name",
  "file-history-snapshot",
  "file-history-delta",
  "atis-latch",
  "api-request",
  "api-request-shape",
  "api-request-blob",
  "tools-used",
  "mode",
  "permission-mode",
  "cost-state",
  "relocated",
  "session-owner",
]);

export class ClaudeCodeAdapter implements TranscriptAdapter {
  readonly stats: AdapterStats = { lines: 0, unknownTypes: {} };
  /** tool_use id → tool name, so tool_results (which carry only the id) can be attributed. */
  private readonly toolNames = new Map<string, string>();
  private tasks: TaskItem[] = [];
  private lastMeta = "";

  parseLine(raw: unknown): AgentEvent[] {
    this.stats.lines++;
    try {
      return this.parse(raw);
    } catch {
      this.countUnknown("<error>");
      return [];
    }
  }

  private countUnknown(type: string): void {
    this.stats.unknownTypes[type] = (this.stats.unknownTypes[type] ?? 0) + 1;
  }

  private parse(raw: unknown): AgentEvent[] {
    if (!isRecord(raw)) {
      this.countUnknown("<non-object>");
      return [];
    }
    const type = str(raw.type) ?? "<missing>";
    const ts = str(raw.timestamp) ?? "";
    const events: AgentEvent[] = [];

    const sessionId = str(raw.sessionId);
    if (sessionId && ts && (type === "user" || type === "assistant" || type === "system")) {
      const cwd = str(raw.cwd);
      const gitBranch = str(raw.gitBranch);
      const key = `${sessionId}\0${cwd}\0${gitBranch}`;
      if (key !== this.lastMeta) {
        this.lastMeta = key;
        events.push({ kind: "session_meta", sessionId, cwd, gitBranch, ts });
      }
    }

    switch (type) {
      case "user":
        events.push(...this.parseUser(raw, ts));
        break;
      case "assistant":
        events.push(...this.parseAssistant(raw, ts));
        break;
      case "system":
        if (raw.subtype === "compact_boundary") events.push({ kind: "compaction", ts });
        break;
      default:
        if (!IGNORED_TYPES.has(type)) this.countUnknown(type);
    }
    return events;
  }

  private parseUser(raw: Record<string, unknown>, ts: string): AgentEvent[] {
    const message = isRecord(raw.message) ? raw.message : {};
    const content = message.content;
    const sidechain = raw.isSidechain === true;
    const events: AgentEvent[] = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        const id = str(block.tool_use_id) ?? "";
        const tool = this.toolNames.get(id) ?? "unknown";
        this.toolNames.delete(id); // results arrive once; keeps the map bounded
        // Echo filter: als-mcp results only close the pending call; their
        // content (a teammate's card) never becomes an event.
        if (block.is_error === true && !isEchoTool(tool)) {
          events.push({ kind: "tool_error", tool, id, ts });
        } else {
          events.push({ kind: "tool_result", tool, id, ts });
        }
      }
    }

    // A tool_result line is the harness talking, even if it also carries text.
    if (events.length) return events;
    if (raw.isMeta === true || raw.isCompactSummary === true) {
      if (raw.isCompactSummary === true) events.push({ kind: "compaction", ts });
      return events;
    }
    const origin = isRecord(raw.origin) ? str(raw.origin.kind) : undefined;
    const turnOrigin = str(raw.turnOrigin);
    if (origin === "task-notification" || turnOrigin === "task_notification") return events;
    if (turnOrigin === "auto_continuation") return events;

    const texts: string[] = [];
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
    }
    const text = texts.join("\n").trim();
    if (text && !NON_PROMPT_TEXT.test(text)) {
      events.push({ kind: "user_prompt", text, sidechain, ts });
    }
    return events;
  }

  private parseAssistant(raw: Record<string, unknown>, ts: string): AgentEvent[] {
    const message = isRecord(raw.message) ? raw.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const sidechain = raw.isSidechain === true;
    const events: AgentEvent[] = [];

    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        events.push({ kind: "assistant_text", text: block.text, sidechain, ts });
      } else if (block.type === "tool_use") {
        const tool = str(block.name) ?? "unknown";
        const id = str(block.id) ?? "";
        if (id) this.toolNames.set(id, tool);
        events.push({ kind: "tool_use", tool, id, ts });
        const input = isRecord(block.input) ? block.input : {};
        events.push(...this.toolSignals(tool, input, ts));
      }
    }
    // Only the main thread ending its turn means "waiting on the user".
    if (message.stop_reason === "end_turn" && !sidechain) events.push({ kind: "turn_end", ts });
    return events;
  }

  private toolSignals(tool: string, input: Record<string, unknown>, ts: string): AgentEvent[] {
    if (EDIT_TOOLS.has(tool)) {
      const path = str(input.file_path) ?? str(input.notebook_path);
      return path ? [{ kind: "file_edit", path, tool, ts }] : [];
    }
    if (tool === "Read") {
      const path = str(input.file_path);
      return path ? [{ kind: "file_read", path, ts }] : [];
    }
    if (tool === "Bash") {
      const cmd = str(input.command);
      return cmd ? [{ kind: "command", cmd, ts }] : [];
    }
    const todo = TODO_TOOLS[tool];
    if (todo) {
      const items = todo(input, this.tasks);
      if (items) {
        this.tasks = items;
        return [{ kind: "todos", items, ts }];
      }
    }
    return [];
  }
}

export interface ParseStats extends AdapterStats {
  malformedLines: number;
}

/** Parse raw JSONL lines with a fresh adapter (convenience for one-shot use). */
export function parseTranscriptLines(
  lines: Iterable<string>,
  adapter = new ClaudeCodeAdapter(),
): { events: AgentEvent[]; stats: ParseStats } {
  const events: AgentEvent[] = [];
  let malformedLines = 0;
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    events.push(...adapter.parseLine(raw));
  }
  return { events, stats: { ...adapter.stats, malformedLines } };
}
