import { describe, expect, it } from "vitest";
import { AgentCard, MAX_CARD_BYTES, serializedCardBytes } from "./schema.js";

// The example card from docs/ARCHITECTURE.md §1.4 (synthetic values).
const exampleCard = (): AgentCard => ({
  v: 1,
  agentId: "gokulsankar--7f3a9c1e",
  owner: { login: "gokulsankar" },
  tool: "claude-code",
  seq: 42,
  updatedAt: "2026-10-31T19:05:00Z",
  status: "active",
  git: { branch: "feat/refresh-tokens", head: "a1b2c3d" },
  intent: "Add refresh-token rotation to auth middleware",
  summary: "Rotation logic written; 2 tests failing on clock skew.",
  tasks: [
    { text: "Write rotation logic", state: "done" },
    { text: "Fix clock-skew tests", state: "in_progress" },
    { text: "Update API docs", state: "pending" },
  ],
  files: {
    modified: ["src/auth/refresh.ts", "src/auth/refresh.test.ts"],
    inProgress: ["src/auth/middleware.ts"],
  },
  claims: [{ glob: "src/auth/**", until: "2026-10-31T20:00:00Z" }],
  decisions: ["Sliding expiry, not fixed window"],
  blockers: [],
  notes: [{ to: "*", text: "Don't touch session.ts, refactoring", at: "2026-10-31T19:00:00Z" }],
  meta: { distillTier: 2, redactions: 1, engine: "0.1.0" },
});

describe("AgentCard schema", () => {
  it("accepts the spec example and round-trips it through JSON unchanged", () => {
    const card = exampleCard();
    const parsed = AgentCard.parse(JSON.parse(JSON.stringify(card)));
    expect(parsed).toEqual(card);
  });

  it("keeps the spec example under the hard byte cap", () => {
    expect(serializedCardBytes(exampleCard())).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });

  it("strips unknown fields so newer minor versions stay readable", () => {
    const parsed = AgentCard.parse({ ...exampleCard(), futureField: "x" });
    expect(parsed).not.toHaveProperty("futureField");
  });

  it("rejects an unknown schema major version", () => {
    expect(AgentCard.safeParse({ ...exampleCard(), v: 2 }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(AgentCard.safeParse({ ...exampleCard(), status: "sleeping" }).success).toBe(false);
  });

  it.each([
    ["intent over 200 chars", { intent: "x".repeat(201) }],
    ["summary over 400 chars", { summary: "x".repeat(401) }],
    ["more than 8 tasks", { tasks: Array(9).fill({ text: "t", state: "pending" }) }],
    ["task text over 80 chars", { tasks: [{ text: "x".repeat(81), state: "pending" }] }],
    ["more than 3 decisions", { decisions: ["a", "b", "c", "d"] }],
    ["more than 3 notes", { notes: Array(4).fill(exampleCard().notes[0]) }],
    [
      "more than 15 modified files",
      { files: { modified: Array(16).fill("a.ts"), inProgress: [] } },
    ],
  ])("rejects %s", (_label, override) => {
    expect(AgentCard.safeParse({ ...exampleCard(), ...override }).success).toBe(false);
  });

  it.each([
    ["missing session suffix", "gokulsankar"],
    ["non-hex session suffix", "gokulsankar--zzzzzzzz"],
    ["login starting with a hyphen", "-gokul--7f3a9c1e"],
  ])("rejects an agentId with %s", (_label, agentId) => {
    expect(AgentCard.safeParse({ ...exampleCard(), agentId }).success).toBe(false);
  });

  it("rejects a negative or fractional seq", () => {
    expect(AgentCard.safeParse({ ...exampleCard(), seq: -1 }).success).toBe(false);
    expect(AgentCard.safeParse({ ...exampleCard(), seq: 1.5 }).success).toBe(false);
  });

  it("rejects a timestamp that is not ISO-8601", () => {
    expect(AgentCard.safeParse({ ...exampleCard(), updatedAt: "yesterday" }).success).toBe(false);
  });
});
