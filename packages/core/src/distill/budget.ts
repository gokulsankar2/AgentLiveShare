import {
  type AgentCard,
  MAX_CARD_BYTES,
  serializedCardBytes,
  TARGET_CARD_BYTES,
} from "../schema.js";
import { MORE_MARKER } from "./card.js";
import { truncate } from "./text.js";

// Budgeter — docs/ARCHITECTURE.md §1.4. Shrinks a card until its serialized
// size is ≤ target. Spec drop order first; the steps after "summary" go past
// the spec so the hard cap holds for any schema-valid input. Throws (fail
// closed) if even the minimal card is over the hard cap.

export class BudgetError extends Error {
  override name = "BudgetError";
}

export interface BudgetOptions {
  target?: number;
  max?: number;
}

export interface BudgetResult {
  card: AgentCard;
  bytes: number;
  /** Names of the steps that removed something, in order. */
  steps: string[];
}

type Step = { name: string; apply: (c: AgentCard) => AgentCard | undefined };

/** Halve a string's length, ending at "" — so a step loop always terminates. */
function shorten(text: string): string | undefined {
  if (!text) return undefined;
  return text.length <= 8 ? "" : truncate(text, Math.floor(text.length / 2));
}

/** Real entries the spec-order file step keeps before moving on to tasks. */
export const MIN_MODIFIED_FILES = 3;

/** Drop the oldest real entry into the `+N more` marker, keeping at least `keep`. */
function shrinkModified(c: AgentCard, keep: number): AgentCard | undefined {
  const m = c.files.modified;
  const last = m[m.length - 1] ?? "";
  const marker = MORE_MARKER.exec(last);
  const real = marker ? m.slice(0, -1) : m;
  if (real.length <= keep) return undefined;
  const hidden = (marker ? Number(marker[1]) : 0) + 1;
  return { ...c, files: { ...c.files, modified: [...real.slice(0, -1), `+${hidden} more`] } };
}

const STEPS: readonly Step[] = [
  // --- spec order (§1.4) ---
  {
    name: "notes",
    apply: (c) => (c.notes.length ? { ...c, notes: c.notes.slice(0, -1) } : undefined),
  },
  {
    name: "decisions",
    apply: (c) => (c.decisions.length ? { ...c, decisions: c.decisions.slice(0, -1) } : undefined),
  },
  {
    name: "files.modified",
    // Keeps the most recent few files: a bare "+N more" tells a teammate nothing.
    apply: (c) => shrinkModified(c, MIN_MODIFIED_FILES),
  },
  {
    name: "tasks.done",
    apply: (c) => {
      const i = c.tasks.findIndex((t) => t.state === "done");
      return i === -1 ? undefined : { ...c, tasks: c.tasks.filter((_, j) => j !== i) };
    },
  },
  {
    name: "summary",
    apply: (c) => {
      const s = shorten(c.summary);
      return s === undefined ? undefined : { ...c, summary: s };
    },
  },
  // --- beyond spec: guarantee the hard cap ---
  {
    name: "files.inProgress",
    apply: (c) =>
      c.files.inProgress.length
        ? { ...c, files: { ...c.files, inProgress: c.files.inProgress.slice(0, -1) } }
        : undefined,
  },
  {
    name: "tasks",
    apply: (c) => (c.tasks.length ? { ...c, tasks: c.tasks.slice(0, -1) } : undefined),
  },
  {
    name: "claims",
    apply: (c) => (c.claims.length ? { ...c, claims: c.claims.slice(0, -1) } : undefined),
  },
  {
    name: "blockers",
    apply: (c) => (c.blockers.length ? { ...c, blockers: c.blockers.slice(0, -1) } : undefined),
  },
  { name: "files.modified.rest", apply: (c) => shrinkModified(c, 0) },
  {
    name: "files.modified.marker",
    apply: (c) =>
      c.files.modified.length ? { ...c, files: { ...c.files, modified: [] } } : undefined,
  },
  {
    name: "intent",
    apply: (c) => {
      const s = shorten(c.intent);
      return s === undefined ? undefined : { ...c, intent: s };
    },
  },
  {
    name: "git.branch",
    apply: (c) => {
      if (c.git.branch.length <= 20) return undefined;
      return { ...c, git: { ...c.git, branch: truncate(c.git.branch, 20) } };
    },
  },
];

export function budgetCard(card: AgentCard, opts: BudgetOptions = {}): BudgetResult {
  const target = opts.target ?? TARGET_CARD_BYTES;
  const max = opts.max ?? MAX_CARD_BYTES;
  let current = card;
  let bytes = serializedCardBytes(current);
  const steps: string[] = [];

  for (const step of STEPS) {
    while (bytes > target) {
      const next = step.apply(current);
      if (!next) break;
      current = next;
      bytes = serializedCardBytes(current);
      if (steps[steps.length - 1] !== step.name) steps.push(step.name);
    }
    if (bytes <= target) break;
  }

  if (bytes > max) throw new BudgetError(`card is ${bytes} bytes after budgeting (cap ${max})`);
  return { card: current, bytes, steps };
}
