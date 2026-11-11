import {
  createScrubber,
  egressGate,
  isNeverSyncPath,
  type RedactConfig,
} from "../redact/redact.js";
import { AgentCard } from "../schema.js";
import type { AgentEvent } from "../transcript/events.js";
import { budgetCard } from "./budget.js";
import { buildTier1Card, type CardContext } from "./card.js";
import { foldEvents, type SessionFacts } from "./facts.js";

// The Week-1 pipeline (§1.1, minus Tier 2 and sync):
//   events → Tier-1 facts → card (scrubbed at full length) → neverSync filter
//   → Budgeter → egress gate on the exact serialized bytes → zod validate.
// Every failure is reported as { ok: false }; nothing half-checked escapes.

export interface DistillOptions extends Omit<CardContext, "scrub"> {
  redact?: RedactConfig;
}

export type DistillOutcome =
  | {
      ok: true;
      card: AgentCard;
      /** Exactly what would be pushed: compact JSON. */
      json: string;
      bytes: number;
      redactions: number;
      budgetSteps: string[];
    }
  | { ok: false; reason: string };

export function distillFacts(facts: SessionFacts, opts: DistillOptions): DistillOutcome {
  try {
    const { redact = {}, ...ctx } = opts;
    const { scrub, totals } = createScrubber(redact);
    // Never-sync files are dropped before the card is built, so the "+N more"
    // marker doesn't count (and so reveal) files that were filtered out.
    const keepPath = (p: string) => !isNeverSyncPath(p, redact);
    const built = buildTier1Card(facts, { ...ctx, scrub, keepPath });
    const card: AgentCard = { ...built, meta: { ...built.meta, redactions: totals.count } };
    const budgeted = budgetCard(card);
    const parsed = AgentCard.safeParse(budgeted.card);
    if (!parsed.success) {
      const where = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
      return { ok: false, reason: `card failed schema validation at: ${where}` };
    }
    // The gate scans exactly these bytes, and they are what callers print or push.
    const json = JSON.stringify(parsed.data);
    const gate = egressGate(json, redact);
    if (!gate.ok) return { ok: false, reason: `${gate.reason} [${gate.rules.join(", ")}]` };
    return {
      ok: true,
      card: parsed.data,
      json,
      bytes: Buffer.byteLength(json, "utf8"),
      redactions: totals.count,
      budgetSteps: budgeted.steps,
    };
  } catch (err) {
    // Fail closed. Only the error class is reported: messages could echo input.
    const name = err instanceof Error ? err.name : "unknown error";
    return { ok: false, reason: `distillation failed (${name})` };
  }
}

export function distillEvents(events: Iterable<AgentEvent>, opts: DistillOptions): DistillOutcome {
  return distillFacts(foldEvents(events), opts);
}
