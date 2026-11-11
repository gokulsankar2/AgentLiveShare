import { describe, it } from "vitest";

// Work queue for the distillation engine — docs/ARCHITECTURE.md §2.2.
// Human-owned: turn each todo into a real test (fixtures in fixtures/transcripts/), then implement.

describe("distill: Tier 1 — intent", () => {
  it.todo("uses the first substantive user prompt as intent");
  it.todo("skips prompts under 20 chars and acknowledgements (yes, ok, continue, go, y)");
  it.todo("strips injected blocks (<system-reminder>, <command-name>, pasted-content tags)");
  it.todo("replaces intent when a later prompt starts a new topic");
  it.todo("truncates to the first sentence, max 200 chars");
  it.todo("ignores isSidechain (subagent) prompts for intent");
});

describe("distill: Tier 1 — tasks and files", () => {
  it.todo("takes tasks from the latest todo-tool input via the tool-name map");
  it.todo("collects files.modified from Edit/Write/MultiEdit/NotebookEdit, most recent first");
  it.todo("makes paths repo-relative and drops paths outside the repo");
  it.todo("keeps subagent (sidechain) file edits");
  it.todo("files.inProgress = files edited in the last 5 minutes (injected clock)");
});

describe("distill: Tier 1 — status, blockers, git", () => {
  it.todo("status = active when the last event is a tool_use without a result");
  it.todo("status = waiting_on_user after turn_end with no newer user prompt");
  it.todo("status = idle after 5 min without writes, ended after 30 min");
  it.todo("adds a blocker after ≥3 errors from the same tool in the last 10 events");
  it.todo("takes git.branch from the transcript's gitBranch field");
});

describe("distill: echo filter", () => {
  it.todo("drops tool_results from als-mcp tools so teammate cards are never republished");
});

describe("distill: Tier 2 — optional Haiku summary", () => {
  it.todo("triggers on a new user prompt, a todo change, or 10 new file edits");
  it.todo("runs at most once per 3 minutes per session; otherwise reuses the last summary");
  it.todo("sends only redacted input: previous card, Tier-1 facts, last 3 prompts, last 2 replies");
  it.todo("validates model output with zod and falls back to Tier 1 on failure or 8s timeout");
  it.todo("records meta.distillTier (2 on success, 1 on fallback)");
});

describe("distill: Budgeter", () => {
  it.todo("always produces a card ≤ MAX_CARD_BYTES (property test)");
  it.todo("drops content in order: notes → decisions → files.modified tail → done tasks → summary");
  it.todo("appends a '+N more' marker when it truncates files.modified");
});
