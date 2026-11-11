import { posix } from "node:path";
import { type AgentCard, type AgentStatus, SCHEMA_VERSION } from "../schema.js";
import { blockersFrom, type SessionFacts } from "./facts.js";
import { firstSentence, truncate } from "./text.js";

// Tier-1 card builder — docs/ARCHITECTURE.md §1.4, §2.2.

export const ENGINE_VERSION = "0.1.0";
export const IN_PROGRESS_MS = 5 * 60_000;
export const IDLE_MS = 5 * 60_000;
export const ENDED_MS = 30 * 60_000;
const MAX_FILES = 15;
const MAX_TASKS = 8;

export interface CardContext {
  login: string;
  /** Short or full HEAD sha (git rev-parse, run by the caller). */
  head: string;
  /** Absolute repo root; edits outside it are dropped. Defaults to the transcript cwd. */
  repoRoot?: string;
  /** Injected clock. */
  now: Date;
  seq?: number;
  /**
   * Applied to every free-text value *before* it is truncated, so a secret is
   * never cut in half (and left unrecognizable) by a length cap.
   */
  scrub?: (text: string) => string;
  /** Repo-relative paths for which this returns false are left out entirely (neverSyncPaths). */
  keepPath?: (repoRelative: string) => boolean;
}

/** Marker entry appended when a file list is truncated: `+N more`. */
export const MORE_MARKER = /^\+(\d+) more$/;

/**
 * Cap a list at `maxEntries` entries *including* a trailing `+N more` marker.
 * An existing marker is merged, so repeated truncation keeps an exact count.
 */
export function truncateWithMarker(list: readonly string[], maxEntries: number): string[] {
  if (list.length <= maxEntries) return [...list];
  let items = [...list];
  let hidden = 0;
  const m = MORE_MARKER.exec(items[items.length - 1] ?? "");
  if (m) {
    hidden = Number(m[1]);
    items = items.slice(0, -1);
  }
  const keep = Math.max(0, maxEntries - 1);
  return [...items.slice(0, keep), `+${hidden + items.length - keep} more`];
}

/** Repo-relative POSIX path, or undefined when the path is outside the repo. */
export function toRepoRelative(
  path: string,
  repoRoot: string,
  cwd: string | undefined,
): string | undefined {
  const abs = posix.isAbsolute(path) ? path : posix.resolve(cwd ?? repoRoot, path);
  const rel = posix.relative(repoRoot, posix.normalize(abs));
  if (!rel || rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) return undefined;
  return rel;
}

export function statusFrom(facts: SessionFacts, now: Date): AgentStatus {
  const last = facts.lastEventAt ? Date.parse(facts.lastEventAt) : Number.NaN;
  const age = Number.isNaN(last) ? Number.POSITIVE_INFINITY : now.getTime() - last;
  if (age >= ENDED_MS) return "ended";
  // A long build/test run writes nothing while its tool call is pending: still active.
  if (facts.pendingTools.length > 0) return "active";
  if (age >= IDLE_MS) return "idle";
  if (facts.awaitingUser) return "waiting_on_user";
  return "active";
}

function summaryFrom(tasks: AgentCard["tasks"], modifiedCount: number): string {
  const parts: string[] = [];
  if (tasks.length) {
    const done = tasks.filter((t) => t.state === "done").length;
    parts.push(`${done}/${tasks.length} tasks done`);
  }
  if (modifiedCount) parts.push(`${modifiedCount} file${modifiedCount === 1 ? "" : "s"} modified`);
  return parts.length ? `${parts.join(", ")}.` : "";
}

export function buildTier1Card(facts: SessionFacts, ctx: CardContext): AgentCard {
  const scrub = ctx.scrub ?? ((s: string) => s);
  const sessionId = (facts.sessionId ?? "").toLowerCase();
  const sid8 = /^[0-9a-f]{8}/.test(sessionId) ? sessionId.slice(0, 8) : "00000000";
  const repoRoot = ctx.repoRoot ?? facts.cwd;

  const modified: string[] = [];
  const inProgress: string[] = [];
  if (repoRoot) {
    for (const e of facts.edits) {
      const rel = toRepoRelative(e.path, repoRoot, e.cwd);
      if (!rel || (ctx.keepPath && !ctx.keepPath(rel))) continue;
      const path = scrub(rel);
      if (path.length > 200) continue;
      modified.push(path);
      if (ctx.now.getTime() - Date.parse(e.ts) < IN_PROGRESS_MS) inProgress.push(path);
    }
  }

  const tasks = facts.tasks.slice(0, MAX_TASKS).map((t) => ({
    text: truncate(scrub(t.text), 80),
    state: t.state,
  }));

  const intent = facts.intentPrompt ? truncate(firstSentence(scrub(facts.intentPrompt)), 200) : "";

  return {
    v: SCHEMA_VERSION,
    agentId: `${ctx.login}--${sid8}`,
    owner: { login: ctx.login },
    tool: "claude-code",
    seq: ctx.seq ?? 0,
    updatedAt: ctx.now.toISOString(),
    status: statusFrom(facts, ctx.now),
    git: {
      branch: truncate(scrub(facts.gitBranch || "unknown"), 100),
      head: ctx.head,
    },
    intent,
    summary: truncate(summaryFrom(tasks, modified.length), 400),
    tasks,
    files: {
      modified: truncateWithMarker(modified, MAX_FILES),
      inProgress: inProgress.slice(0, MAX_FILES),
    },
    claims: [],
    decisions: [],
    blockers: blockersFrom(facts)
      .slice(0, 3)
      .map((b) => truncate(scrub(b), 120)),
    notes: [],
    meta: { distillTier: 1, redactions: 0, engine: ENGINE_VERSION },
  };
}
