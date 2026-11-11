import type { AgentEvent, TaskItem } from "../transcript/events.js";
import { cleanPrompt, contentWords, isNewTopic, isSubstantive } from "./text.js";

// Tier-1 reducer — docs/ARCHITECTURE.md §2.2. Folds AgentEvents into
// SessionFacts. Pure and incremental: the daemon can keep one SessionFacts per
// session and feed it new events as the tailer produces them.

export interface FileEdit {
  /** Path exactly as the tool received it (absolute or cwd-relative). */
  path: string;
  /** cwd at the time of the edit, for resolving relative paths. */
  cwd: string | undefined;
  ts: string;
}

export interface SessionFacts {
  sessionId: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  /** Full cleaned text of the prompt chosen as intent (redact before truncating). */
  intentPrompt: string | undefined;
  /** Content words of the current topic, for new-topic detection. */
  topicWords: string[];
  /** Last 3 cleaned main-thread prompts (Tier-2 input later). */
  recentPrompts: string[];
  tasks: TaskItem[];
  /** One entry per distinct path, most recent edit first. */
  edits: FileEdit[];
  /** tool_use ids with no result yet. */
  pendingTools: string[];
  /** Main-thread turn ended and no prompt has arrived since. */
  awaitingUser: boolean;
  /** Outcomes of the last 10 tool calls, for the blocker heuristic. */
  window: { tool: string; ok: boolean }[];
  lastEventAt: string | undefined;
}

export const BLOCKER_WINDOW = 10;
export const BLOCKER_MIN_ERRORS = 3;

export function emptyFacts(): SessionFacts {
  return {
    sessionId: undefined,
    cwd: undefined,
    gitBranch: undefined,
    intentPrompt: undefined,
    topicWords: [],
    recentPrompts: [],
    tasks: [],
    edits: [],
    pendingTools: [],
    awaitingUser: false,
    window: [],
    lastEventAt: undefined,
  };
}

function pathWords(path: string): string[] {
  return [...contentWords(path.replace(/\.[a-z0-9]+$/i, ""))];
}

function laterTs(a: string | undefined, b: string): string {
  if (!a) return b;
  return Date.parse(b) >= Date.parse(a) ? b : a;
}

export function reduceFacts(facts: SessionFacts, event: AgentEvent): SessionFacts {
  const f: SessionFacts = { ...facts };
  if (event.ts && !Number.isNaN(Date.parse(event.ts)))
    f.lastEventAt = laterTs(f.lastEventAt, event.ts);
  if (event.kind === "tool_result" || event.kind === "tool_error") {
    const outcome = { tool: event.tool, ok: event.kind === "tool_result" };
    f.window = [...f.window, outcome].slice(-BLOCKER_WINDOW);
  }

  switch (event.kind) {
    case "session_meta":
      f.sessionId = event.sessionId;
      if (event.cwd) f.cwd = event.cwd;
      if (event.gitBranch) f.gitBranch = event.gitBranch;
      break;

    case "user_prompt": {
      // Subagent prompts are written by the parent agent, not the human.
      if (event.sidechain) break;
      f.awaitingUser = false;
      const cleaned = cleanPrompt(event.text);
      if (!isSubstantive(cleaned)) break;
      f.recentPrompts = [...f.recentPrompts, cleaned].slice(-3);
      const vocab = new Set(f.topicWords);
      if (!f.intentPrompt || isNewTopic(cleaned, vocab)) {
        f.intentPrompt = cleaned;
        f.topicWords = [...contentWords(cleaned)];
      } else {
        f.topicWords = [...new Set([...f.topicWords, ...contentWords(cleaned)])];
      }
      break;
    }

    case "tool_use":
      f.pendingTools = [...f.pendingTools, event.id];
      f.awaitingUser = false;
      break;

    case "tool_result":
    case "tool_error":
      f.pendingTools = f.pendingTools.filter((id) => id !== event.id);
      break;

    case "file_edit": {
      // Sidechain edits are kept: a subagent's edits are this session's edits.
      const edit: FileEdit = { path: event.path, cwd: f.cwd, ts: event.ts };
      f.edits = [edit, ...f.edits.filter((e) => e.path !== event.path)];
      f.topicWords = [...new Set([...f.topicWords, ...pathWords(event.path)])];
      break;
    }

    case "todos":
      f.tasks = event.items;
      break;

    case "turn_end":
      f.awaitingUser = true;
      f.pendingTools = [];
      break;

    case "compaction":
    case "assistant_text":
    case "file_read":
    case "command":
      break;
  }
  return f;
}

export function foldEvents(events: Iterable<AgentEvent>, start = emptyFacts()): SessionFacts {
  let f = start;
  for (const e of events) f = reduceFacts(f, e);
  return f;
}

/** `Repeated <tool> failures` for every tool with ≥3 errors in the last 10 tool results. */
export function blockersFrom(facts: SessionFacts): string[] {
  const counts = new Map<string, number>();
  for (const e of facts.window) {
    if (!e.ok) counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, n]) => n >= BLOCKER_MIN_ERRORS)
    .map(([tool]) => `Repeated ${tool} failures`);
}
