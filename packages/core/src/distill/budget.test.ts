import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AgentCard, MAX_CARD_BYTES, serializedCardBytes, TARGET_CARD_BYTES } from "../schema.js";
import { parseTranscriptLines } from "../transcript/claude-code.js";
import { BudgetError, budgetCard } from "./budget.js";
import { distillEvents } from "./pipeline.js";

// docs/ARCHITECTURE.md §1.4 (Budgeter) and the Week-1 pipeline.

const base = (): AgentCard => ({
  v: 1,
  agentId: "dev--c0ffee00",
  owner: { login: "dev" },
  tool: "claude-code",
  seq: 1,
  updatedAt: "2026-11-11T10:00:00Z",
  status: "active",
  git: { branch: "main", head: "abc1234" },
  intent: "Add refresh-token rotation",
  summary: "1/3 tasks done, 3 files modified.",
  tasks: [],
  files: { modified: [], inProgress: [] },
  claims: [],
  decisions: [],
  blockers: [],
  notes: [],
  meta: { distillTier: 1, redactions: 0, engine: "0.1.0" },
});
const long = (n: number, c = "x") => c.repeat(n);
const at = "2026-11-11T10:00:00Z";

describe("distill: Budgeter", () => {
  it("leaves a card that already fits untouched", () => {
    const card = base();
    const r = budgetCard(card);
    expect(r.card).toBe(card);
    expect(r.steps).toEqual([]);
  });

  it("drops content in order: notes → decisions → files.modified tail → done tasks → summary", () => {
    const card: AgentCard = {
      ...base(),
      summary: long(300, "s"),
      notes: [1, 2, 3].map((i) => ({ to: "*", text: long(150, `${i}`), at })),
      decisions: [1, 2, 3].map((i) => long(110, `${i}`)),
      files: {
        modified: Array.from({ length: 15 }, (_, i) => `src/module-${i}/file-${i}.ts`),
        inProgress: [],
      },
      tasks: [
        { text: long(70, "d"), state: "done" },
        { text: long(70, "e"), state: "done" },
        { text: long(70, "p"), state: "pending" },
      ],
    };
    const r = budgetCard(card);
    expect(r.bytes).toBeLessThanOrEqual(TARGET_CARD_BYTES);
    expect(r.steps.slice(0, 3)).toEqual(["notes", "decisions", "files.modified"]);
    expect(r.card.notes).toEqual([]);
    expect(r.card.decisions).toEqual([]);

    // Only as much as needed: a card a little over budget loses only (some) notes.
    const slightly: AgentCard = {
      ...base(),
      notes: card.notes,
      decisions: card.decisions.slice(0, 1),
    };
    const s = budgetCard(slightly);
    expect(s.steps).toEqual(["notes"]);
    expect(s.card.decisions).toHaveLength(1);
    expect(s.card.notes.length).toBeGreaterThan(0);
  });

  it("appends a '+N more' marker when it truncates files.modified", () => {
    const files = Array.from(
      { length: 15 },
      (_, i) => `packages/feature-${i}/src/component-${i}.tsx`,
    );
    const r = budgetCard({ ...base(), files: { modified: files, inProgress: [] } });
    const m = r.card.files.modified;
    const marker = m[m.length - 1] ?? "";
    expect(marker).toMatch(/^\+\d+ more$/);
    expect(m.length - 1 + Number(marker.match(/\d+/)?.[0])).toBe(15);
    expect(m[0]).toBe(files[0]); // most recent kept
  });

  it("keeps the 3 most recent files before dropping tasks; the rest go only as a last resort", () => {
    const files = Array.from(
      { length: 15 },
      (_, i) => `packages/feature-${i}/src/component-${i}.tsx`,
    );
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      text: `${long(70)}${i}`,
      state: "pending" as const,
    }));
    const r = budgetCard({ ...base(), tasks, files: { modified: files, inProgress: [] } });
    expect(r.card.files.modified).toEqual([...files.slice(0, 3), "+12 more"]);
    expect(r.steps).toEqual(["files.modified", "summary", "tasks"]);
  });

  it("drops done tasks before pending ones, then shortens the summary", () => {
    const card: AgentCard = {
      ...base(),
      summary: long(400, "s"),
      tasks: [
        ...Array.from({ length: 4 }, () => ({ text: long(80, "d"), state: "done" as const })),
        ...Array.from({ length: 4 }, () => ({ text: long(80, "p"), state: "pending" as const })),
      ],
    };
    const r = budgetCard(card);
    expect(r.steps[0]).toBe("tasks.done");
    expect(r.card.tasks.every((t) => t.state === "pending")).toBe(true);
    expect(r.card.tasks).toHaveLength(4);
  });

  it("throws (fail closed) when even the minimal card exceeds the hard cap", () => {
    expect(() => budgetCard(base(), { target: 10, max: 20 })).toThrow(BudgetError);
  });

  it("always produces a card ≤ MAX_CARD_BYTES (property test)", () => {
    fc.assert(
      fc.property(cardArb, (card) => {
        expect(AgentCard.safeParse(card).success).toBe(true);
        const r = budgetCard(card);
        expect(r.bytes).toBe(serializedCardBytes(r.card));
        expect(r.bytes).toBeLessThanOrEqual(MAX_CARD_BYTES);
        expect(r.bytes).toBeLessThanOrEqual(TARGET_CARD_BYTES);
        expect(AgentCard.safeParse(r.card).success).toBe(true);
        if (serializedCardBytes(card) <= TARGET_CARD_BYTES) expect(r.card).toBe(card);
      }),
      { numRuns: 300 },
    );
  });
});

describe("distill pipeline", () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`../../../../fixtures/transcripts/${name}`, import.meta.url), "utf8")
      .split("\n")
      .filter(Boolean);
  const opts = { login: "dev", head: "abc1234", now: new Date("2026-11-11T10:07:30Z") };

  it("turns a transcript into a valid, redacted card ≤ 1 KB", () => {
    const { events } = parseTranscriptLines(fixture("synthetic-cli.jsonl"));
    const out = distillEvents(events, opts);
    if (!out.ok) throw new Error(out.reason);
    expect(out.bytes).toBeLessThanOrEqual(TARGET_CARD_BYTES);
    expect(out.json).toBe(JSON.stringify(out.card));
    expect(out.card.intent).toBe("Add refresh-token rotation to the auth middleware.");
  });

  it("redacts secrets in prompts and counts them in meta.redactions", () => {
    const events = [
      {
        kind: "session_meta",
        sessionId: "c0ffee00-0000-4000-8000-000000000000",
        cwd: "/r",
        ts: at,
      },
      {
        kind: "user_prompt",
        text: "Deploy with AKIAIOSFODNN7EXAMPLE and email ops@example.com when done.",
        sidechain: false,
        ts: at,
      },
      { kind: "file_edit", path: "/r/.env.local", tool: "Edit", ts: at },
      { kind: "file_edit", path: "/r/src/deploy.ts", tool: "Edit", ts: at },
    ] as const;
    const out = distillEvents(events, { ...opts, now: new Date("2026-11-11T10:01:00Z") });
    if (!out.ok) throw new Error(out.reason);
    expect(out.card.intent).toBe(
      "Deploy with [REDACTED:aws_access_key] and email [REDACTED:email] when done.",
    );
    expect(out.card.meta.redactions).toBe(2);
    expect(out.card.files.modified).toEqual(["src/deploy.ts"]);
  });

  it("never-sync files don't inflate the '+N more' marker", () => {
    const edits = Array.from({ length: 20 }, (_, i) => ({
      kind: "file_edit" as const,
      path: i % 4 === 0 ? `/r/cfg${i}/.env` : `/r/src/f${i}.ts`,
      tool: "Edit",
      ts: at,
    }));
    const out = distillEvents(
      [
        {
          kind: "session_meta",
          sessionId: "c0ffee00-0000-4000-8000-000000000000",
          cwd: "/r",
          ts: at,
        },
        ...edits,
      ],
      { ...opts, now: new Date("2026-11-11T10:01:00Z") },
    );
    if (!out.ok) throw new Error(out.reason);
    const m = out.card.files.modified;
    const shown = m.filter((p) => !p.startsWith("+")).length;
    const hidden = Number(m.at(-1)?.match(/^\+(\d+) more$/)?.[1] ?? 0);
    expect(shown + hidden).toBe(15); // 20 edits minus 5 .env files
    expect(m.some((p) => p.includes(".env"))).toBe(false);
  });

  it("fails closed when the redactor throws", () => {
    const { events } = parseTranscriptLines(fixture("synthetic-cli.jsonl"));
    const out = distillEvents(events, { ...opts, redact: { extraPatterns: ["(bad"] } });
    expect(out).toEqual({ ok: false, reason: "distillation failed (RedactionError)" });
  });

  it("fails closed when the card fails schema validation", () => {
    const { events } = parseTranscriptLines(fixture("synthetic-cli.jsonl"));
    const out = distillEvents(events, { ...opts, login: "not a valid login!" });
    expect(out.ok).toBe(false);
  });
});

// --- arbitrary schema-valid cards ---------------------------------------------

const str = (max: number, min = 0) =>
  fc
    .string({ minLength: min, maxLength: max, unit: "grapheme" })
    .map((s) => s.slice(0, max))
    .filter((s) => s.length >= min);
const login = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const iso = fc
  .date({ min: new Date("2020-01-01"), max: new Date("2030-01-01"), noInvalidDate: true })
  .map((d) => d.toISOString());
const cardArb: fc.Arbitrary<AgentCard> = fc
  .record({
    login,
    sid: fc.stringMatching(/^[0-9a-f]{8}$/),
    seq: fc.nat(),
    updatedAt: iso,
    status: fc.constantFrom("active", "waiting_on_user", "idle", "ended"),
    branch: str(100, 1),
    head: fc.stringMatching(/^[0-9a-f]{7,40}$/),
    intent: str(200),
    summary: str(400),
    tasks: fc.array(
      fc.record({ text: str(80, 1), state: fc.constantFrom("pending", "in_progress", "done") }),
      { maxLength: 8 },
    ),
    modified: fc.array(str(200, 1), { maxLength: 15 }),
    inProgress: fc.array(str(200, 1), { maxLength: 15 }),
    claims: fc.array(
      fc.record({
        glob: str(200, 1),
        since: fc.integer({ min: 0, max: 1e9 }),
        dur: fc.integer({ min: 1000, max: 1e8 }),
      }),
      { maxLength: 5 },
    ),
    decisions: fc.array(str(120, 1), { maxLength: 3 }),
    blockers: fc.array(str(120, 1), { maxLength: 3 }),
    notes: fc.array(
      fc.record({ to: fc.oneof(fc.constant("*"), login), text: str(200, 1), at: iso }),
      { maxLength: 3 },
    ),
    redactions: fc.nat(),
  })
  .map((r) => ({
    v: 1 as const,
    agentId: `${r.login}--${r.sid}`,
    owner: { login: r.login },
    tool: "claude-code" as const,
    seq: r.seq,
    updatedAt: r.updatedAt,
    status: r.status,
    git: { branch: r.branch, head: r.head },
    intent: r.intent,
    summary: r.summary,
    tasks: r.tasks,
    files: { modified: r.modified, inProgress: r.inProgress },
    claims: r.claims.map((c) => {
      const since = Date.parse("2026-01-01T00:00:00Z") + c.since;
      return {
        glob: c.glob,
        since: new Date(since).toISOString(),
        until: new Date(since + c.dur).toISOString(),
      };
    }),
    decisions: r.decisions,
    blockers: r.blockers,
    notes: r.notes,
    meta: { distillTier: 1 as const, redactions: r.redactions, engine: "0.1.0" },
  }));
